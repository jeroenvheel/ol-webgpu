//! Readers for OpenLayers render instructions (`ol/render/webgl/renderinstructions.js`,
//! ol 10.11). The framing and the bounds checks live here: a truncated or
//! malformed array ends the iteration, it never reads out of bounds.

/// Floats per vertex of a line: x, y, measure.
pub const LINE_VERTEX_SIZE: usize = 3;

/// One line string: `[custom.., n, (x, y, m) * n]`.
pub struct Line<'a> {
    pub custom: &'a [f32],
    /// `LINE_VERTEX_SIZE` floats per vertex.
    pub vertices: &'a [f32],
}

/// One polygon: `[custom.., rings, count per ring.., (x, y) * sum of counts]`.
pub struct Polygon<'a> {
    pub custom: &'a [f32],
    pub ring_counts: &'a [f32],
    pub coords: &'a [f32],
}

pub struct Lines<'a> {
    instructions: &'a [f32],
    custom_size: usize,
    at: usize,
}

pub struct Polygons<'a> {
    instructions: &'a [f32],
    custom_size: usize,
    at: usize,
}

pub fn lines(instructions: &[f32], custom_size: usize) -> Lines<'_> {
    Lines { instructions, custom_size, at: 0 }
}

pub fn polygons(instructions: &[f32], custom_size: usize) -> Polygons<'_> {
    Polygons { instructions, custom_size, at: 0 }
}

impl<'a> Iterator for Lines<'a> {
    type Item = Line<'a>;

    fn next(&mut self) -> Option<Line<'a>> {
        let instr = self.instructions;
        let n = instr.len();
        let custom_start = self.at;
        // an element stops the iteration for good when it does not fit
        self.at = n;
        let header = custom_start.checked_add(self.custom_size).filter(|i| *i < n)?;
        let count = instr[header] as usize;
        let start = header + 1;
        let end = count.checked_mul(LINE_VERTEX_SIZE).and_then(|len| start.checked_add(len)).filter(|e| *e <= n)?;
        self.at = end;
        Some(Line { custom: &instr[custom_start..header], vertices: &instr[start..end] })
    }
}

impl<'a> Iterator for Polygons<'a> {
    type Item = Polygon<'a>;

    fn next(&mut self) -> Option<Polygon<'a>> {
        let instr = self.instructions;
        let n = instr.len();
        let custom_start = self.at;
        self.at = n;
        let header = custom_start.checked_add(self.custom_size).filter(|i| *i < n)?;
        let rings = instr[header] as usize;
        let counts_start = header + 1;
        let coords_start = counts_start.checked_add(rings).filter(|e| *e <= n)?;
        let ring_counts = &instr[counts_start..coords_start];
        let mut total = 0usize;
        for c in ring_counts {
            total = total.checked_add(*c as usize)?;
        }
        let end = total.checked_mul(2).and_then(|len| coords_start.checked_add(len)).filter(|e| *e <= n)?;
        self.at = end;
        Some(Polygon { custom: &instr[custom_start..header], ring_counts, coords: &instr[coords_start..end] })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_lines_and_polygons() {
        let l = [7.0, 2.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 8.0, 1.0, 5.0, 5.0, 0.0];
        let got: Vec<_> = lines(&l, 1).map(|x| (x.custom[0], x.vertices.len())).collect();
        assert_eq!(got, vec![(7.0, 6), (8.0, 3)]);

        let p = [9.0, 2.0, 3.0, 3.0, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 1.0, 1.0, 2.0, 1.0, 1.0, 2.0];
        let got: Vec<_> = polygons(&p, 1).map(|x| (x.custom[0], x.ring_counts.len(), x.coords.len())).collect();
        assert_eq!(got, vec![(9.0, 2, 12)]);
    }

    #[test]
    fn stops_at_truncated_or_absurd_input() {
        assert_eq!(lines(&[0.0, 1000.0, 1.0], 1).count(), 0);
        assert_eq!(lines(&[f32::MAX, 1.0], 0).count(), 0);
        assert_eq!(lines(&[1.0], 3).count(), 0);
        assert_eq!(polygons(&[3.0, 100.0, 1.0], 0).count(), 0);
        assert_eq!(polygons(&[2.0, f32::MAX, f32::MAX, 0.0], 0).count(), 0);
        // a complete element before a truncated one is still read
        assert_eq!(lines(&[1.0, 0.0, 0.0, 0.0, 5.0, 1.0], 0).count(), 1);
    }
}
