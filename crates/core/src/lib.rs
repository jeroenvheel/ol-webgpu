//! ol-webgpu core: geometry work for the WebGL2 and WebGPU vector layers.
//!
//! The wasm ABI is deliberately plain `extern "C"` (no wasm-bindgen): JS
//! allocates input in linear memory with `olgpu_alloc`, calls a `build_*`
//! function, then copies the output buffers out using `olgpu_out_ptr` /
//! `olgpu_out_len`. Each worker (and the main thread) owns its own instance,
//! so the global state is single-threaded.

pub mod index;
pub mod instructions;
pub mod tessellate;

use std::cell::RefCell;
use tessellate::Buffers;

struct State {
    out: Buffers,
    earcut: earcut::Earcut<f64>,
    /// The index built last (`olgpu_index_build`), which goes to another instance.
    index: index::PackedIndex,
    /// The loaded indexes, one per layer; a handle is the position plus one.
    loaded: Vec<Option<index::PackedIndex>>,
    hits: Vec<u32>,
    query: index::QueryScratch,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        out: Buffers::default(),
        earcut: earcut::Earcut::new(),
        index: index::PackedIndex::default(),
        loaded: Vec::new(),
        hits: Vec::new(),
        query: index::QueryScratch::default(),
    });
}

/// Allocates `len` bytes (8-byte aligned) and returns the pointer.
#[unsafe(no_mangle)]
pub extern "C" fn olgpu_alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u64> = Vec::with_capacity(len.div_ceil(8).max(1));
    let ptr = v.as_mut_ptr() as *mut u8;
    std::mem::forget(v);
    ptr
}

/// Frees memory obtained from `olgpu_alloc` with the same `len`.
///
/// # Safety
/// `ptr` must come from `olgpu_alloc(len)` and not be freed twice.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn olgpu_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let cap = len.div_ceil(8).max(1);
    drop(unsafe { Vec::from_raw_parts(ptr as *mut u64, 0, cap) });
}

unsafe fn slice_f32<'a>(ptr: *const f32, len: usize) -> &'a [f32] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

/// # Safety
/// `ptr` must point to `len` readable f32 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn olgpu_build_points(ptr: *const f32, len: usize, custom_size: usize) {
    let instr = unsafe { slice_f32(ptr, len) };
    STATE.with_borrow_mut(|s| tessellate::build_points(instr, custom_size, &mut s.out));
}

/// `t0..t5` is the inverse of the transform used to create the instructions.
///
/// # Safety
/// `ptr` must point to `len` readable f32 values.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn olgpu_build_lines(
    ptr: *const f32,
    len: usize,
    custom_size: usize,
    t0: f64,
    t1: f64,
    t2: f64,
    t3: f64,
    t4: f64,
    t5: f64,
) {
    let instr = unsafe { slice_f32(ptr, len) };
    let t = [t0, t1, t2, t3, t4, t5];
    STATE.with_borrow_mut(|s| tessellate::build_lines(instr, custom_size, &t, &mut s.out));
}

/// # Safety
/// `ptr` must point to `len` readable f32 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn olgpu_build_polygons(ptr: *const f32, len: usize, custom_size: usize) {
    let instr = unsafe { slice_f32(ptr, len) };
    STATE.with_borrow_mut(|s| {
        let State { out, earcut, .. } = s;
        tessellate::build_polygons(instr, custom_size, earcut, out)
    });
}

/// Output buffer pointer: 0 = indices (u32), 1 = vertices (f32), 2 = instances (f32),
/// 3 = query hits (`index::HIT_WORDS` words per hit), 4 = serialized index (f32).
#[unsafe(no_mangle)]
pub extern "C" fn olgpu_out_ptr(kind: u32) -> *const u8 {
    STATE.with_borrow(|s| match kind {
        0 => s.out.indices.as_ptr() as *const u8,
        1 => s.out.vertices.as_ptr() as *const u8,
        2 => s.out.instances.as_ptr() as *const u8,
        3 => s.hits.as_ptr() as *const u8,
        4 => s.index.data().as_ptr() as *const u8,
        _ => std::ptr::null(),
    })
}

/// Output buffer length in elements (see `olgpu_out_ptr`).
#[unsafe(no_mangle)]
pub extern "C" fn olgpu_out_len(kind: u32) -> usize {
    STATE.with_borrow(|s| match kind {
        0 => s.out.indices.len(),
        1 => s.out.vertices.len(),
        2 => s.out.instances.len(),
        3 => s.hits.len(),
        4 => s.index.data().len(),
        _ => 0,
    })
}

/// Releases tessellation output memory after JS copied it.
#[unsafe(no_mangle)]
pub extern "C" fn olgpu_out_reset() {
    STATE.with_borrow_mut(|s| s.out = Buffers::default());
}

/// Builds the spatial index from the three instruction arrays (same layouts
/// as the `build_*` functions). `ref_offset` is the position of the feature
/// ref inside the custom attributes; `t0..t5` maps instruction
/// coordinates to index space. The serialized index is then available
/// through `olgpu_out_ptr(4)`.
///
/// # Safety
/// Each pointer must point to the given number of readable f32 values.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn olgpu_index_build(
    points_ptr: *const f32,
    points_len: usize,
    lines_ptr: *const f32,
    lines_len: usize,
    polygons_ptr: *const f32,
    polygons_len: usize,
    custom_size: usize,
    ref_offset: usize,
    t0: f64,
    t1: f64,
    t2: f64,
    t3: f64,
    t4: f64,
    t5: f64,
) {
    let points = unsafe { slice_f32(points_ptr, points_len) };
    let lines = unsafe { slice_f32(lines_ptr, lines_len) };
    let polygons = unsafe { slice_f32(polygons_ptr, polygons_len) };
    STATE.with_borrow_mut(|s| {
        // the previous index goes first, so the two are not in memory together
        s.index = index::PackedIndex::default();
        s.index = index::PackedIndex::build(points, lines, polygons, custom_size, ref_offset, &[t0, t1, t2, t3, t4, t5])
    });
}

/// Drops the index built last, after JS copied it (`olgpu_out_ptr(4)`).
#[unsafe(no_mangle)]
pub extern "C" fn olgpu_index_reset() {
    STATE.with_borrow_mut(|s| s.index = index::PackedIndex::default());
}

/// Loads a serialized index previously read through `olgpu_out_ptr(4)`.
/// Returns its handle for `olgpu_index_query` and `olgpu_index_free`, or 0
/// if the data is not a valid index. Every layer has its own.
///
/// # Safety
/// `ptr` must point to `len` readable f32 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn olgpu_index_load(ptr: *const f32, len: usize) -> u32 {
    let data = unsafe { slice_f32(ptr, len) };
    let Some(idx) = index::PackedIndex::from_data(data) else {
        return 0;
    };
    STATE.with_borrow_mut(|s| {
        let slot = match s.loaded.iter().position(Option::is_none) {
            Some(slot) => slot,
            None => {
                s.loaded.push(None);
                s.loaded.len() - 1
            }
        };
        s.loaded[slot] = Some(idx);
        slot as u32 + 1
    })
}

/// Frees an index loaded with `olgpu_index_load` (an unknown handle is ignored).
#[unsafe(no_mangle)]
pub extern "C" fn olgpu_index_free(handle: u32) {
    STATE.with_borrow_mut(|s| {
        if let Some(slot) = (handle as usize).checked_sub(1).and_then(|i| s.loaded.get_mut(i)) {
            *slot = None;
        }
    });
}

/// Finds entries within `radius` of (x, y), in index units, in the index of
/// `handle` (0: the index built last in this instance). Results are read
/// with `olgpu_out_ptr(3)` as `[ref, kind, seq, distance(f32 bits)]` per hit,
/// topmost first (points over lines over polygons, later over earlier).
/// Returns the number of hits.
#[unsafe(no_mangle)]
pub extern "C" fn olgpu_index_query(handle: u32, x: f64, y: f64, radius: f64) -> usize {
    STATE.with_borrow_mut(|s| {
        let State { index, loaded, hits, query, .. } = s;
        let index = match handle {
            0 => Some(&*index),
            _ => loaded.get(handle as usize - 1).and_then(Option::as_ref),
        };
        match index {
            Some(index) => index.query_with(x, y, radius, hits, query),
            None => hits.clear(),
        }
        hits.len() / index::HIT_WORDS
    })
}
