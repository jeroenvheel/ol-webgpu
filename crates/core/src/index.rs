//! Packed Hilbert R-tree (same scheme as flatbush) over the geometries of
//! the render instructions, used for CPU hit detection.
//!
//! Items: one per point, one per chunk of up to `LINE_CHUNK` line segments,
//! one per polygon. Coordinates are in instruction space; the caller converts
//! the query position and radius into that space.

const NODE_SIZE: usize = 16;
const LINE_CHUNK: usize = 32;
const MAGIC: u32 = 0x4F4C_4731; // "OLG1"

pub const KIND_POLYGON: u32 = 0;
pub const KIND_LINE: u32 = 1;
pub const KIND_POINT: u32 = 2;

#[derive(Default, Debug, Clone)]
pub struct PackedIndex {
    num_items: usize,
    /// 4 floats per node (minX, minY, maxX, maxY), leaves first, root last.
    boxes: Vec<f32>,
    /// Per node: item index (leaves) or first child node position.
    indices: Vec<u32>,
    /// End node position (exclusive) of each level, leaves first.
    level_bounds: Vec<u32>,
    /// 4 words per item: kind, seq, ref, geometry offset.
    meta: Vec<u32>,
    /// Geometry: point `[x, y]`; line `[n, x0, y0, ...]`;
    /// polygon `[rings, count0.., x0, y0, ...]`.
    geom: Vec<f32>,
    serialized: Vec<f32>,
}

struct Item {
    bbox: [f32; 4],
    kind: u32,
    seq: u32,
    r#ref: u32,
    geom: u32,
}

fn bbox_of(coords: &[f32]) -> [f32; 4] {
    let mut b = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
    for c in coords.chunks_exact(2) {
        b[0] = b[0].min(c[0]);
        b[1] = b[1].min(c[1]);
        b[2] = b[2].max(c[0]);
        b[3] = b[3].max(c[1]);
    }
    b
}

impl PackedIndex {
    /// `t` maps instruction coordinates to index space (OpenLayers transform
    /// layout `[a, b, c, d, e, f]`); use the identity to keep them as is.
    pub fn build(
        points: &[f32],
        lines: &[f32],
        polygons: &[f32],
        custom_size: usize,
        ref_offset: usize,
        t: &[f64; 6],
    ) -> Self {
        let mut items: Vec<Item> = Vec::new();
        let mut geom: Vec<f32> = Vec::new();
        let tx = |x: f32, y: f32| -> [f32; 2] {
            let (x, y) = (x as f64, y as f64);
            [(t[0] * x + t[2] * y + t[4]) as f32, (t[1] * x + t[3] * y + t[5]) as f32]
        };
        let mut scratch: Vec<f32> = Vec::new();
        let ref_at = |instr: &[f32], start: usize| -> u32 {
            if ref_offset < custom_size { instr[start + ref_offset] as u32 } else { 0 }
        };

        // polygons: [custom.., rings, counts.., coords..]
        let mut i = 0usize;
        let mut seq = 0u32;
        while i < polygons.len() {
            let custom_start = i;
            i += custom_size;
            if i >= polygons.len() {
                break;
            }
            let rings = polygons[i] as usize;
            i += 1;
            if i + rings > polygons.len() {
                break;
            }
            let counts = &polygons[i..i + rings];
            let total: usize = counts.iter().map(|c| *c as usize).sum();
            i += rings;
            if i + total * 2 > polygons.len() {
                break;
            }
            scratch.clear();
            for c in polygons[i..i + total * 2].chunks_exact(2) {
                scratch.extend_from_slice(&tx(c[0], c[1]));
            }
            let coords = &scratch[..];
            items.push(Item {
                bbox: bbox_of(coords),
                kind: KIND_POLYGON,
                seq,
                r#ref: ref_at(polygons, custom_start),
                geom: geom.len() as u32,
            });
            geom.push(rings as f32);
            geom.extend_from_slice(counts);
            geom.extend_from_slice(coords);
            i += total * 2;
            seq += 1;
        }

        // lines: [custom.., n, (x, y, m) * n]
        let mut i = 0usize;
        let mut seq = 0u32;
        while i < lines.len() {
            let custom_start = i;
            i += custom_size;
            if i >= lines.len() {
                break;
            }
            let vc = lines[i] as usize;
            i += 1;
            if i + vc * 3 > lines.len() {
                break;
            }
            let r = ref_at(lines, custom_start);
            let mut start = 0usize;
            while start + 1 < vc {
                let end = (start + LINE_CHUNK).min(vc - 1);
                let offset = geom.len() as u32;
                geom.push((end - start + 1) as f32);
                for v in start..=end {
                    geom.extend_from_slice(&tx(lines[i + v * 3], lines[i + v * 3 + 1]));
                }
                items.push(Item {
                    bbox: bbox_of(&geom[offset as usize + 1..]),
                    kind: KIND_LINE,
                    seq,
                    r#ref: r,
                    geom: offset,
                });
                start = end;
            }
            i += vc * 3;
            seq += 1;
        }

        // points: [x, y, custom..]
        let stride = 2 + custom_size;
        for (seq, p) in points.chunks_exact(stride).enumerate() {
            let [x, y] = tx(p[0], p[1]);
            items.push(Item {
                bbox: [x, y, x, y],
                kind: KIND_POINT,
                seq: seq as u32,
                r#ref: if ref_offset < custom_size { p[2 + ref_offset] as u32 } else { 0 },
                geom: geom.len() as u32,
            });
            geom.push(x);
            geom.push(y);
        }

        let mut idx = Self::pack(items, geom);
        idx.serialize();
        idx
    }

    fn pack(items: Vec<Item>, geom: Vec<f32>) -> Self {
        let n = items.len();
        let mut idx = PackedIndex { num_items: n, geom, ..Default::default() };
        idx.meta.reserve(n * 4);
        for it in &items {
            idx.meta.extend_from_slice(&[it.kind, it.seq, it.r#ref, it.geom]);
        }
        if n == 0 {
            return idx;
        }

        // level bounds
        let mut num_nodes = n;
        let mut nn = n;
        idx.level_bounds.push(n as u32);
        loop {
            nn = nn.div_ceil(NODE_SIZE);
            num_nodes += nn;
            idx.level_bounds.push(num_nodes as u32);
            if nn == 1 {
                break;
            }
        }

        // hilbert sort of item centers
        let mut bounds = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
        for it in &items {
            bounds[0] = bounds[0].min(it.bbox[0]);
            bounds[1] = bounds[1].min(it.bbox[1]);
            bounds[2] = bounds[2].max(it.bbox[2]);
            bounds[3] = bounds[3].max(it.bbox[3]);
        }
        let w = (bounds[2] - bounds[0]) as f64;
        let h = (bounds[3] - bounds[1]) as f64;
        let hmax = 65535.0f64;
        let mut order: Vec<(u32, u32)> = items
            .iter()
            .enumerate()
            .map(|(k, it)| {
                let cx = (it.bbox[0] as f64 + it.bbox[2] as f64) / 2.0;
                let cy = (it.bbox[1] as f64 + it.bbox[3] as f64) / 2.0;
                let hx = if w > 0.0 { (hmax * (cx - bounds[0] as f64) / w).floor() } else { 0.0 };
                let hy = if h > 0.0 { (hmax * (cy - bounds[1] as f64) / h).floor() } else { 0.0 };
                (hilbert(hx as u32, hy as u32), k as u32)
            })
            .collect();
        order.sort_unstable();

        idx.boxes = vec![0.0; num_nodes * 4];
        idx.indices = vec![0; num_nodes];
        for (pos, (_, k)) in order.iter().enumerate() {
            idx.boxes[pos * 4..pos * 4 + 4].copy_from_slice(&items[*k as usize].bbox);
            idx.indices[pos] = *k;
        }

        // upper levels
        let mut pos = 0usize;
        let mut out = n;
        for l in 0..idx.level_bounds.len() - 1 {
            let end = idx.level_bounds[l] as usize;
            while pos < end {
                let first = pos;
                let mut b = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
                let mut k = 0;
                while k < NODE_SIZE && pos < end {
                    b[0] = b[0].min(idx.boxes[pos * 4]);
                    b[1] = b[1].min(idx.boxes[pos * 4 + 1]);
                    b[2] = b[2].max(idx.boxes[pos * 4 + 2]);
                    b[3] = b[3].max(idx.boxes[pos * 4 + 3]);
                    pos += 1;
                    k += 1;
                }
                idx.boxes[out * 4..out * 4 + 4].copy_from_slice(&b);
                idx.indices[out] = first as u32;
                out += 1;
            }
        }
        idx
    }

    pub fn data(&self) -> &[f32] {
        &self.serialized
    }

    fn serialize(&mut self) {
        let mut s: Vec<f32> = Vec::with_capacity(
            6 + self.level_bounds.len() + self.boxes.len() + self.indices.len() + self.meta.len() + self.geom.len(),
        );
        let u = f32::from_bits;
        s.push(u(MAGIC));
        s.push(u(self.num_items as u32));
        s.push(u(self.level_bounds.len() as u32));
        s.push(u(self.indices.len() as u32));
        s.push(u(self.geom.len() as u32));
        s.push(0.0);
        s.extend(self.level_bounds.iter().map(|v| u(*v)));
        s.extend_from_slice(&self.boxes);
        s.extend(self.indices.iter().map(|v| u(*v)));
        s.extend(self.meta.iter().map(|v| u(*v)));
        s.extend_from_slice(&self.geom);
        self.serialized = s;
    }

    pub fn from_data(data: &[f32]) -> Option<Self> {
        let w = |i: usize| data.get(i).map(|v| v.to_bits());
        if w(0)? != MAGIC {
            return None;
        }
        let num_items = w(1)? as usize;
        let levels = w(2)? as usize;
        let num_nodes = w(3)? as usize;
        let geom_len = w(4)? as usize;
        let mut p = 6usize;
        let total = p + levels + num_nodes * 4 + num_nodes + num_items * 4 + geom_len;
        if data.len() < total {
            return None;
        }
        let take = |p: &mut usize, n: usize| {
            let r = &data[*p..*p + n];
            *p += n;
            r
        };
        let level_bounds = take(&mut p, levels).iter().map(|v| v.to_bits()).collect();
        let boxes = take(&mut p, num_nodes * 4).to_vec();
        let indices = take(&mut p, num_nodes).iter().map(|v| v.to_bits()).collect();
        let meta = take(&mut p, num_items * 4).iter().map(|v| v.to_bits()).collect();
        let geom = take(&mut p, geom_len).to_vec();
        Some(PackedIndex {
            num_items,
            boxes,
            indices,
            level_bounds,
            meta,
            geom,
            serialized: Vec::new(),
        })
    }

    pub fn len(&self) -> usize {
        self.num_items
    }

    pub fn is_empty(&self) -> bool {
        self.num_items == 0
    }

    /// Appends `[ref, kind, seq, distance bits]` for each item within `radius`,
    /// deduplicated per geometry and sorted topmost first.
    pub fn query(&self, x: f64, y: f64, radius: f64, hits: &mut Vec<u32>) {
        hits.clear();
        if self.num_items == 0 {
            return;
        }
        let mut found: Vec<(u32, u32, u32, f64)> = Vec::new(); // kind, seq, ref, distance
        let n = self.num_items;
        let levels = self.level_bounds.len();
        let root = self.indices.len() - 1;
        let mut stack: Vec<(usize, usize)> = vec![(root, levels - 1)];

        while let Some((node, level)) = stack.pop() {
            let end = (node + NODE_SIZE).min(self.level_bounds[level] as usize);
            for pos in node..end {
                let b = &self.boxes[pos * 4..pos * 4 + 4];
                if x < b[0] as f64 - radius
                    || y < b[1] as f64 - radius
                    || x > b[2] as f64 + radius
                    || y > b[3] as f64 + radius
                {
                    continue;
                }
                let target = self.indices[pos] as usize;
                if pos < n {
                    if let Some(d) = self.distance(target, x, y)
                        && d <= radius
                    {
                        let m = &self.meta[target * 4..target * 4 + 4];
                        found.push((m[0], m[1], m[2], d));
                    }
                } else {
                    stack.push((target, level - 1));
                }
            }
        }

        // topmost first: higher kind, then higher seq; keep min distance per geometry
        found.sort_unstable_by(|a, b| {
            b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(a.3.total_cmp(&b.3))
        });
        let mut last: Option<(u32, u32)> = None;
        for (kind, seq, r, d) in found {
            if last == Some((kind, seq)) {
                continue;
            }
            last = Some((kind, seq));
            hits.extend_from_slice(&[r, kind, seq, (d as f32).to_bits()]);
        }
    }

    fn distance(&self, item: usize, x: f64, y: f64) -> Option<f64> {
        let kind = self.meta[item * 4];
        let g = self.meta[item * 4 + 3] as usize;
        let geom = &self.geom;
        match kind {
            KIND_POINT => {
                let dx = x - geom[g] as f64;
                let dy = y - geom[g + 1] as f64;
                Some((dx * dx + dy * dy).sqrt())
            }
            KIND_LINE => {
                let count = geom[g] as usize;
                let c = &geom[g + 1..g + 1 + count * 2];
                let mut best = f64::INFINITY;
                for k in 0..count.saturating_sub(1) {
                    best = best.min(segment_distance(
                        x,
                        y,
                        c[k * 2] as f64,
                        c[k * 2 + 1] as f64,
                        c[k * 2 + 2] as f64,
                        c[k * 2 + 3] as f64,
                    ));
                }
                Some(best)
            }
            KIND_POLYGON => {
                let rings = geom[g] as usize;
                let counts = &geom[g + 1..g + 1 + rings];
                let mut p = g + 1 + rings;
                let mut inside = false;
                let mut best = f64::INFINITY;
                for count in counts {
                    let count = *count as usize;
                    let c = &geom[p..p + count * 2];
                    let mut j = count.saturating_sub(1);
                    for k in 0..count {
                        let (xi, yi) = (c[k * 2] as f64, c[k * 2 + 1] as f64);
                        let (xj, yj) = (c[j * 2] as f64, c[j * 2 + 1] as f64);
                        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
                            inside = !inside;
                        }
                        best = best.min(segment_distance(x, y, xj, yj, xi, yi));
                        j = k;
                    }
                    p += count * 2;
                }
                Some(if inside { 0.0 } else { best })
            }
            _ => None,
        }
    }
}

fn segment_distance(x: f64, y: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    let dx = x1 - x0;
    let dy = y1 - y0;
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((x - x0) * dx + (y - y0) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    let px = x0 + t * dx - x;
    let py = y0 + t * dy - y;
    (px * px + py * py).sqrt()
}

/// Hilbert curve index of a point on a 16-bit grid (from flatbush).
#[allow(non_snake_case)]
fn hilbert(x: u32, y: u32) -> u32 {
    let mut a = x ^ y;
    let mut b = 0xFFFF ^ a;
    let mut c = 0xFFFF ^ (x | y);
    let mut d = x & (y ^ 0xFFFF);

    let mut A = a | (b >> 1);
    let mut B = (a >> 1) ^ a;
    let mut C = ((c >> 1) ^ (b & (d >> 1))) ^ c;
    let mut D = ((a & (c >> 1)) ^ (d >> 1)) ^ d;

    a = A;
    b = B;
    c = C;
    d = D;
    A = (a & (a >> 2)) ^ (b & (b >> 2));
    B = (a & (b >> 2)) ^ (b & ((a ^ b) >> 2));
    C ^= (a & (c >> 2)) ^ (b & (d >> 2));
    D ^= (b & (c >> 2)) ^ ((a ^ b) & (d >> 2));

    a = A;
    b = B;
    c = C;
    d = D;
    A = (a & (a >> 4)) ^ (b & (b >> 4));
    B = (a & (b >> 4)) ^ (b & ((a ^ b) >> 4));
    C ^= (a & (c >> 4)) ^ (b & (d >> 4));
    D ^= (b & (c >> 4)) ^ ((a ^ b) & (d >> 4));

    a = A;
    b = B;
    c = C;
    d = D;
    C ^= (a & (c >> 8)) ^ (b & (d >> 8));
    D ^= (b & (c >> 8)) ^ ((a ^ b) & (d >> 8));

    a = C ^ (C >> 1);
    b = D ^ (D >> 1);

    let mut i0 = x ^ y;
    let mut i1 = b | (0xFFFF ^ (i0 | a));

    i0 = (i0 | (i0 << 8)) & 0x00FF00FF;
    i0 = (i0 | (i0 << 4)) & 0x0F0F0F0F;
    i0 = (i0 | (i0 << 2)) & 0x33333333;
    i0 = (i0 | (i0 << 1)) & 0x55555555;

    i1 = (i1 | (i1 << 8)) & 0x00FF00FF;
    i1 = (i1 | (i1 << 4)) & 0x0F0F0F0F;
    i1 = (i1 | (i1 << 2)) & 0x33333333;
    i1 = (i1 | (i1 << 1)) & 0x55555555;

    (i1 << 1) | i0
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    #[test]
    fn transform_is_applied() {
        let points = [1.0, 2.0, 5.0];
        // scale x2, translate +10
        let idx = PackedIndex::build(&points, &[], &[], 1, 0, &[2.0, 0.0, 0.0, 2.0, 10.0, 10.0]);
        let mut hits = vec![];
        idx.query(12.0, 14.0, 0.1, &mut hits);
        assert_eq!(refs(&hits), vec![5]);
    }

    fn refs(hits: &[u32]) -> Vec<u32> {
        hits.chunks_exact(4).map(|h| h[0]).collect()
    }

    #[test]
    fn empty_index() {
        let idx = PackedIndex::build(&[], &[], &[], 1, 0, &ID);
        let mut hits = vec![];
        idx.query(0.0, 0.0, 10.0, &mut hits);
        assert!(hits.is_empty());
    }

    #[test]
    fn points_lines_polygons_topmost_first() {
        // custom size 1 = ref
        let points = [5.0, 5.0, 10.0, 100.0, 100.0, 11.0];
        let lines = [20.0, 2.0, 0.0, 5.0, 0.0, 10.0, 5.0, 0.0];
        let polygons = [30.0, 1.0, 4.0, 0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0];
        let idx = PackedIndex::build(&points, &lines, &polygons, 1, 0, &ID);
        let mut hits = vec![];
        idx.query(5.0, 5.0, 0.5, &mut hits);
        assert_eq!(refs(&hits), vec![10, 20, 30]);
        idx.query(8.0, 8.0, 0.5, &mut hits);
        assert_eq!(refs(&hits), vec![30]);
        idx.query(50.0, 50.0, 0.5, &mut hits);
        assert!(hits.is_empty());
        idx.query(100.0, 101.0, 1.5, &mut hits);
        assert_eq!(refs(&hits), vec![11]);
    }

    #[test]
    fn polygon_hole_is_not_hit() {
        let polygons = [
            1.0, 2.0, 4.0, 4.0, 0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0, 2.0, 2.0, 2.0, 8.0, 8.0,
            8.0, 8.0, 2.0,
        ];
        let idx = PackedIndex::build(&[], &[], &polygons, 1, 0, &ID);
        let mut hits = vec![];
        idx.query(5.0, 5.0, 0.0, &mut hits);
        assert!(hits.is_empty());
        idx.query(1.0, 1.0, 0.0, &mut hits);
        assert_eq!(refs(&hits), vec![1]);
    }

    #[test]
    fn long_line_chunks_deduplicated() {
        let mut lines = vec![7.0, 100.0];
        for k in 0..100 {
            lines.extend_from_slice(&[k as f32, 0.0, 0.0]);
        }
        let idx = PackedIndex::build(&[], &lines, &[], 1, 0, &ID);
        let mut hits = vec![];
        idx.query(32.0, 0.1, 0.5, &mut hits); // on a chunk boundary
        assert_eq!(refs(&hits), vec![7]);
    }

    #[test]
    fn many_points_and_serialization_roundtrip() {
        let mut points = vec![];
        for k in 0..10_000 {
            points.extend_from_slice(&[(k % 100) as f32, (k / 100) as f32, k as f32]);
        }
        let idx = PackedIndex::build(&points, &[], &[], 1, 0, &ID);
        let loaded = PackedIndex::from_data(idx.data()).unwrap();
        let mut hits = vec![];
        loaded.query(42.0, 17.0, 0.1, &mut hits);
        assert_eq!(refs(&hits), vec![17 * 100 + 42]);
        loaded.query(42.5, 17.0, 0.6, &mut hits);
        assert_eq!(hits.len() / 4, 2);
        assert!(PackedIndex::from_data(&[1.0, 2.0]).is_none());
    }
}
