//! GLSL (Vulkan flavour, produced by `src/style/glsl.ts` from ol's GLSL ES
//! 1.00 shaders) to WGSL, using naga. Returns the WGSL source plus the
//! reflection the WebGPU renderer needs: uniform block member offsets,
//! vertex input locations and texture/sampler bindings.

use naga::{AddressSpace, Binding, ScalarKind, ShaderStage, TypeInner};
use std::cell::RefCell;
use std::fmt::Write;

pub struct UniformMember {
    pub name: String,
    pub offset: u32,
    /// "f32", "i32", "u32", "vec2", "vec3", "vec4", "mat4", ...
    pub ty: String,
    pub size: u32,
}

pub struct Resource {
    pub name: String,
    pub group: u32,
    pub binding: u32,
    /// "uniform", "texture", "sampler"
    pub kind: &'static str,
}

pub struct Translation {
    pub wgsl: String,
    pub uniforms: Vec<UniformMember>,
    pub uniform_block_size: u32,
    pub inputs: Vec<(String, u32)>,
    pub resources: Vec<Resource>,
}

fn type_name(module: &naga::Module, ty: naga::Handle<naga::Type>) -> String {
    let scalar = |k: ScalarKind| match k {
        ScalarKind::Float => "f32",
        ScalarKind::Sint => "i32",
        ScalarKind::Uint => "u32",
        ScalarKind::Bool => "bool",
        _ => "?",
    };
    match &module.types[ty].inner {
        TypeInner::Scalar(s) => scalar(s.kind).to_string(),
        TypeInner::Vector { size, scalar: s } => format!("vec{}<{}>", *size as u8, scalar(s.kind)),
        TypeInner::Matrix { columns, rows, .. } => format!("mat{}x{}", *columns as u8, *rows as u8),
        TypeInner::Array { base, size, .. } => {
            let n = match size {
                naga::ArraySize::Constant(n) => n.get(),
                _ => 0,
            };
            format!("array<{},{}>", type_name(module, *base), n)
        }
        other => format!("{other:?}"),
    }
}

pub fn translate(src: &str, stage: ShaderStage) -> Result<Translation, String> {
    let mut frontend = naga::front::glsl::Frontend::default();
    let module = frontend
        .parse(&naga::front::glsl::Options::from(stage), src)
        .map_err(|e| format!("GLSL parse error:\n{}", e.emit_to_string(src)))?;

    // Uniformity is relaxed through a WGSL diagnostic directive instead:
    // ol's shaders sample textures after discard, as is legal in GLSL.
    let flags = naga::valid::ValidationFlags::all() ^ naga::valid::ValidationFlags::CONTROL_FLOW_UNIFORMITY;
    let info = naga::valid::Validator::new(flags, naga::valid::Capabilities::all())
        .validate(&module)
        .map_err(|e| format!("validation error:\n{}", e.emit_to_string(src)))?;

    let wgsl = naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
        .map_err(|e| format!("WGSL writer error: {e}"))?;

    let mut uniforms = Vec::new();
    let mut uniform_block_size = 0;
    let mut resources = Vec::new();
    for (_, var) in module.global_variables.iter() {
        let Some(binding) = &var.binding else { continue };
        let name = var.name.clone().unwrap_or_default();
        match var.space {
            AddressSpace::Uniform => {
                if let TypeInner::Struct { members, span } = &module.types[var.ty].inner {
                    uniform_block_size = *span;
                    for m in members {
                        uniforms.push(UniformMember {
                            name: m.name.clone().unwrap_or_default(),
                            offset: m.offset,
                            ty: type_name(&module, m.ty),
                            size: module.types[m.ty].inner.size(module.to_ctx()),
                        });
                    }
                }
                resources.push(Resource { name, group: binding.group, binding: binding.binding, kind: "uniform" });
            }
            AddressSpace::Handle => {
                let kind = match module.types[var.ty].inner {
                    TypeInner::Sampler { .. } => "sampler",
                    _ => "texture",
                };
                resources.push(Resource { name, group: binding.group, binding: binding.binding, kind });
            }
            _ => {}
        }
    }

    let mut inputs = Vec::new();
    if let Some(ep) = module.entry_points.first() {
        for arg in &ep.function.arguments {
            if let Some(Binding::Location { location, .. }) = arg.binding {
                inputs.push((arg.name.clone().unwrap_or_default(), location));
            }
            // struct-typed arguments (naga may group inputs)
            if let TypeInner::Struct { members, .. } = &module.types[arg.ty].inner {
                for m in members {
                    if let Some(Binding::Location { location, .. }) = m.binding {
                        inputs.push((m.name.clone().unwrap_or_default(), location));
                    }
                }
            }
        }
    }

    Ok(Translation { wgsl, uniforms, uniform_block_size, inputs, resources })
}

fn json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn translate_json(src: &str, stage: ShaderStage) -> String {
    let mut o = String::new();
    match translate(src, stage) {
        Err(e) => {
            o.push_str("{\"ok\":false,\"error\":");
            json_str(&mut o, &e);
            o.push('}');
        }
        Ok(t) => {
            o.push_str("{\"ok\":true,\"wgsl\":");
            json_str(&mut o, &t.wgsl);
            let _ = write!(o, ",\"uniformBlockSize\":{},\"uniforms\":[", t.uniform_block_size);
            for (i, u) in t.uniforms.iter().enumerate() {
                if i > 0 {
                    o.push(',');
                }
                o.push_str("{\"name\":");
                json_str(&mut o, &u.name);
                let _ = write!(o, ",\"offset\":{},\"size\":{},\"type\":", u.offset, u.size);
                json_str(&mut o, &u.ty);
                o.push('}');
            }
            o.push_str("],\"inputs\":[");
            for (i, (name, loc)) in t.inputs.iter().enumerate() {
                if i > 0 {
                    o.push(',');
                }
                o.push_str("{\"name\":");
                json_str(&mut o, name);
                let _ = write!(o, ",\"location\":{loc}}}");
            }
            o.push_str("],\"resources\":[");
            for (i, r) in t.resources.iter().enumerate() {
                if i > 0 {
                    o.push(',');
                }
                o.push_str("{\"name\":");
                json_str(&mut o, &r.name);
                let _ = write!(o, ",\"group\":{},\"binding\":{},\"kind\":\"{}\"}}", r.group, r.binding, r.kind);
            }
            o.push_str("]}");
        }
    }
    o
}

thread_local! {
    static OUT: RefCell<String> = const { RefCell::new(String::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn olgpu_shader_alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `olgpu_shader_alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn olgpu_shader_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

/// Translates UTF-8 GLSL at `ptr` (stage 0 = vertex, 1 = fragment). The JSON
/// result is read with `olgpu_shader_out_ptr` / `olgpu_shader_out_len`.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn olgpu_shader_translate(ptr: *const u8, len: usize, stage: u32) {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let src = String::from_utf8_lossy(bytes);
    let stage = if stage == 0 { ShaderStage::Vertex } else { ShaderStage::Fragment };
    let json = translate_json(&src, stage);
    OUT.with_borrow_mut(|o| *o = json);
}

#[unsafe(no_mangle)]
pub extern "C" fn olgpu_shader_out_ptr() -> *const u8 {
    OUT.with_borrow(|o| o.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn olgpu_shader_out_len() -> usize {
    OUT.with_borrow(|o| o.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_vertex_with_uniform_block() {
        let src = r#"#version 450
layout(set = 0, binding = 0, std140) uniform OlUniforms {
  mat4 u_projectionMatrix;
  float u_depth;
  vec2 u_viewportSizePx;
};
layout(location = 0) in vec2 a_position;
layout(location = 0) out vec4 v_color;
void main() {
  gl_Position = u_projectionMatrix * vec4(a_position, u_depth, 1.0);
  v_color = vec4(mod(-1.5, 1.0));
}
"#;
        let t = translate(src, ShaderStage::Vertex).unwrap();
        assert!(t.wgsl.contains("@vertex"));
        let names: Vec<_> = t.uniforms.iter().map(|u| (u.name.as_str(), u.offset)).collect();
        assert_eq!(names, vec![("u_projectionMatrix", 0), ("u_depth", 64), ("u_viewportSizePx", 72)]);
        assert_eq!(t.inputs, vec![("a_position".to_string(), 0)]);
        println!("{}", t.wgsl);
    }
}
