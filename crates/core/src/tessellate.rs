//! Buffer generation from OpenLayers render instructions.
//!
//! Faithful port of the loops in `ol/worker/webgl.js` and the helpers in
//! `ol/render/webgl/bufferUtil.js` (ol 10.11). Input and output layouts are
//! identical, so buffers produced here can be drawn by the same shaders.
//! All arithmetic is done in f64 (like JS) and rounded to f32 on output
//! (like `Float32Array.from`).

use crate::instructions::{self, LINE_VERTEX_SIZE};
use std::f64::consts::PI;

/// Same constant as `LINESTRING_ANGLE_COSINE_CUTOFF` in bufferUtil.js.
pub const LINESTRING_ANGLE_COSINE_CUTOFF: f64 = 0.985;

/// The quad shared by all instanced primitives (points, line segments).
pub const QUAD_INDICES: [u32; 6] = [0, 1, 3, 1, 2, 3];
pub const QUAD_VERTICES: [f32; 8] = [-1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0];

/// Number of base (non-custom) floats per line segment instance.
pub const LINE_SEGMENT_BASE_SIZE: usize = 11;

#[derive(Default, Debug, Clone)]
pub struct Buffers {
    pub indices: Vec<u32>,
    pub vertices: Vec<f32>,
    pub instances: Vec<f32>,
}

impl Buffers {
    pub fn clear(&mut self) {
        self.indices.clear();
        self.vertices.clear();
        self.instances.clear();
    }

    fn set_quad(&mut self) {
        self.indices.extend_from_slice(&QUAD_INDICES);
        self.vertices.extend_from_slice(&QUAD_VERTICES);
    }
}

/// 2D affine transform in OpenLayers layout `[a, b, c, d, e, f]`.
pub type Transform = [f64; 6];

#[inline(always)]
fn apply(t: &Transform, x: f64, y: f64) -> (f64, f64) {
    (t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5])
}

/// Port of `angleBetween` from `ol/coordinate.js`.
#[inline]
pub fn angle_between(p0: (f64, f64), pa: (f64, f64), pb: (f64, f64)) -> f64 {
    let len_a = ((pa.0 - p0.0) * (pa.0 - p0.0) + (pa.1 - p0.1) * (pa.1 - p0.1)).sqrt();
    let tan_a = ((pa.0 - p0.0) / len_a, (pa.1 - p0.1) / len_a);
    let ortho_a = (-tan_a.1, tan_a.0);
    let len_b = ((pb.0 - p0.0) * (pb.0 - p0.0) + (pb.1 - p0.1) * (pb.1 - p0.1)).sqrt();
    let tan_b = ((pb.0 - p0.0) / len_b, (pb.1 - p0.1) / len_b);

    let mut angle = if len_a == 0.0 || len_b == 0.0 {
        0.0
    } else {
        (tan_b.0 * tan_a.0 + tan_b.1 * tan_a.1).clamp(-1.0, 1.0).acos()
    };
    // JS: Math.max(angle, 0.00001); NaN propagates in JS, keep the same behaviour
    if !(angle >= 0.00001) && !angle.is_nan() {
        angle = 0.00001;
    }
    let is_clockwise = tan_b.0 * ortho_a.0 + tan_b.1 * ortho_a.1 > 0.0;
    if !is_clockwise { PI * 2.0 - angle } else { angle }
}

/// Point instances: `[x, y, custom...]` per point. The instruction layout is
/// identical, so this is a straight copy (kept for API symmetry).
pub fn build_points(instructions: &[f32], custom_size: usize, out: &mut Buffers) {
    out.clear();
    out.set_quad();
    let stride = 2 + custom_size;
    let count = instructions.len() / stride;
    out.instances.extend_from_slice(&instructions[..count * stride]);
}

/// Line segment instances, see `writeLineSegmentToBuffers`.
/// Layout per instance: `p0.x, p0.y, m0, p1.x, p1.y, m1, angle0, angle1,
/// distanceLow, distanceHigh, angleTangentSum, custom...`.
///
/// `to_world` is the inverse of the transform used to create the instructions.
pub fn build_lines(instructions: &[f32], custom_size: usize, to_world: &Transform, out: &mut Buffers) {
    out.clear();
    out.set_quad();

    const PER_VERTEX: usize = LINE_VERTEX_SIZE;

    // first pass: count segments to allocate once
    let segments: usize = instructions::lines(instructions, custom_size)
        .map(|line| (line.vertices.len() / PER_VERTEX).saturating_sub(1))
        .sum();
    out.instances.reserve(segments * (LINE_SEGMENT_BASE_SIZE + custom_size));

    let max_precision = 2f64.powi(24);
    for line in instructions::lines(instructions, custom_size) {
        let vertices = line.vertices;
        let instr = |i: usize| vertices[i] as f64;
        let vc = vertices.len() / PER_VERTEX;
        let i = 0usize;
        let first = i;
        let is_loop = vc >= 2 && {
            let last = i + (vc - 1) * PER_VERTEX;
            vertices[first] == vertices[last] && vertices[first + 1] == vertices[last + 1]
        };
        let last = if vc >= 1 { i + (vc - 1) * PER_VERTEX } else { i };

        let mut current_length = 0.0f64;
        let mut tangent_sum = 0.0f64;

        for k in 0..vc.saturating_sub(1) {
            let before = if k > 0 {
                Some(i + (k - 1) * PER_VERTEX)
            } else if is_loop {
                Some(last - PER_VERTEX)
            } else {
                None
            };
            let after = if k + 2 < vc {
                Some(i + (k + 2) * PER_VERTEX)
            } else if is_loop {
                Some(first + PER_VERTEX)
            } else {
                None
            };
            let s = i + k * PER_VERTEX;
            let e = i + (k + 1) * PER_VERTEX;

            let p0 = (instr(s), instr(s + 1));
            let p1 = (instr(e), instr(e + 1));
            let m0 = vertices[s + 2];
            let m1 = vertices[e + 2];
            let p0w = apply(to_world, p0.0, p0.1);
            let p1w = apply(to_world, p1.0, p1.1);

            let mut angle0 = -1.0f64;
            let mut angle1 = -1.0f64;
            let mut new_sum = tangent_sum;

            if let Some(b) = before {
                let pbw = apply(to_world, instr(b), instr(b + 1));
                angle0 = angle_between(p0w, p1w, pbw);
                if angle0.cos() <= LINESTRING_ANGLE_COSINE_CUTOFF {
                    new_sum += ((angle0 - PI) / 2.0).tan();
                }
            }
            if let Some(a) = after {
                let paw = apply(to_world, instr(a), instr(a + 1));
                angle1 = angle_between(p1w, p0w, paw);
                if angle1.cos() <= LINESTRING_ANGLE_COSINE_CUTOFF {
                    new_sum += ((PI - angle1) / 2.0).tan();
                }
            }

            let distance_low = current_length % max_precision;
            let distance_high = (current_length / max_precision).floor() * max_precision;

            out.instances.extend_from_slice(&[
                p0.0 as f32,
                p0.1 as f32,
                m0,
                p1.0 as f32,
                p1.1 as f32,
                m1,
                angle0 as f32,
                angle1 as f32,
                distance_low as f32,
                distance_high as f32,
                tangent_sum as f32,
            ]);
            out.instances.extend_from_slice(line.custom);

            let dx = p1w.0 - p0w.0;
            let dy = p1w.1 - p0w.1;
            current_length += (dx * dx + dy * dy).sqrt();
            tangent_sum = new_sum;
        }
    }
}

/// Polygon triangles, see `writePolygonTrianglesToBuffers`.
/// Vertex layout: `x, y, custom...`; indices are u32.
pub fn build_polygons(
    instructions: &[f32],
    custom_size: usize,
    earcut: &mut earcut::Earcut<f64>,
    out: &mut Buffers,
) {
    out.clear();
    let attrs_per_vertex = 2 + custom_size;
    let mut coords: Vec<[f64; 2]> = Vec::new();
    let mut holes: Vec<u32> = Vec::new();
    let mut triangles: Vec<u32> = Vec::new();

    // first pass: count vertices to allocate once (a polygon of v vertices
    // and h holes has at most v + 2h - 2 triangles)
    let (mut vertices, mut triangles_max) = (0usize, 0usize);
    for polygon in instructions::polygons(instructions, custom_size) {
        let count = polygon.coords.len() / 2;
        vertices += count;
        triangles_max += count + 2 * polygon.ring_counts.len().saturating_sub(1);
    }
    out.vertices.reserve(vertices * attrs_per_vertex);
    out.indices.reserve(triangles_max * 3);

    for polygon in instructions::polygons(instructions, custom_size) {
        holes.clear();
        let mut vertices_count = 0usize;
        for (r, count) in polygon.ring_counts.iter().enumerate() {
            vertices_count += *count as usize;
            if r + 1 < polygon.ring_counts.len() {
                holes.push(vertices_count as u32);
            }
        }
        coords.clear();
        coords.extend(polygon.coords.chunks_exact(2).map(|c| [c[0] as f64, c[1] as f64]));

        let base = (out.vertices.len() / attrs_per_vertex) as u32;
        earcut.earcut_slice(&coords, &holes, &mut triangles);
        out.indices.extend(triangles.iter().map(|t| t + base));

        for c in polygon.coords.chunks_exact(2) {
            out.vertices.push(c[0]);
            out.vertices.push(c[1]);
            out.vertices.extend_from_slice(polygon.custom);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY: Transform = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    #[test]
    fn points_copy_instances() {
        let instr = [1.0, 2.0, 9.0, 3.0, 4.0, 8.0];
        let mut out = Buffers::default();
        build_points(&instr, 1, &mut out);
        assert_eq!(out.indices, QUAD_INDICES);
        assert_eq!(out.vertices, QUAD_VERTICES);
        assert_eq!(out.instances, instr);
    }

    #[test]
    fn line_open_has_caps_and_lengths() {
        // custom attr 7, 3 vertices: (0,0) (10,0) (10,10), measures 0
        let instr = [7.0, 3.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 10.0, 0.0];
        let mut out = Buffers::default();
        build_lines(&instr, 1, &IDENTITY, &mut out);
        let stride = LINE_SEGMENT_BASE_SIZE + 1;
        assert_eq!(out.instances.len(), 2 * stride);
        let s0 = &out.instances[0..stride];
        let s1 = &out.instances[stride..2 * stride];
        assert_eq!(s0[6], -1.0); // cap at start
        assert!(s0[7] > 0.0); // join at end
        assert!(s1[6] > 0.0);
        assert_eq!(s1[7], -1.0); // cap at end
        assert_eq!(s1[8], 10.0); // distanceLow = length of first segment
        assert_eq!(s0[11], 7.0);
        assert_eq!(s1[11], 7.0);
    }

    #[test]
    fn line_loop_has_no_caps() {
        let instr = [
            4.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 10.0, 0.0, 0.0, 0.0, 0.0,
        ];
        let mut out = Buffers::default();
        build_lines(&instr, 0, &IDENTITY, &mut out);
        let stride = LINE_SEGMENT_BASE_SIZE;
        for s in out.instances.chunks_exact(stride) {
            assert!(s[6] > 0.0 && s[7] > 0.0);
        }
    }

    #[test]
    fn polygon_with_hole() {
        // square 0..10 with a hole 2..8, custom attr 5
        let instr = [
            5.0, 2.0, 4.0, 4.0, //
            0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0, //
            2.0, 2.0, 2.0, 8.0, 8.0, 8.0, 8.0, 2.0,
        ];
        let mut ec = earcut::Earcut::new();
        let mut out = Buffers::default();
        build_polygons(&instr, 1, &mut ec, &mut out);
        assert_eq!(out.vertices.len(), 8 * 3);
        assert_eq!(out.indices.len(), 8 * 3); // 8 triangles
        let area: f64 = out
            .indices
            .chunks_exact(3)
            .map(|t| {
                let p = |k: u32| {
                    let o = k as usize * 3;
                    (out.vertices[o] as f64, out.vertices[o + 1] as f64)
                };
                let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
                ((b.0 - a.0) * (c.1 - a.1) - (c.0 - a.0) * (b.1 - a.1)).abs() / 2.0
            })
            .sum();
        assert!((area - 64.0).abs() < 1e-9);
    }

    #[test]
    fn malformed_input_does_not_panic() {
        let mut out = Buffers::default();
        build_lines(&[0.0, 1000.0, 1.0], 0, &IDENTITY, &mut out);
        let mut ec = earcut::Earcut::new();
        build_polygons(&[3.0, 100.0, 1.0], 0, &mut ec, &mut out);
    }
}
