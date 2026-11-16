/** Original, standalone Rust tasks; no target repository source is included. */
export const additionalTasks = [
	{
		name: 'utf16-offsets',
		signature: 'fn utf16_to_byte(source: &str, offset: u32) -> Option<usize>',
		prompt: `Fix this Rust function. The input offset counts UTF-16 code units; return the corresponding UTF-8 byte offset. Accept the end of the string. Return None for an out-of-range offset or an offset inside a surrogate pair. Support every valid Rust string and every u32 offset. Keep the signature and use only the standard library.

fn utf16_to_byte(source: &str, offset: u32) -> Option<usize> {
    Some(source.chars().take(offset as usize).map(char::len_utf8).sum())
}`,
		tests: String.raw`
#[test]
fn unicode_boundaries() {
    let mut strings = vec![String::new()];
    for _ in 0..4 {
        let prior = strings.clone();
        for s in prior {
            for c in ['a', 'é', '中', '🦀', '\r', '\n', '\0'] {
                strings.push(format!("{s}{c}"));
            }
        }
    }
    for source in strings {
        let mut boundaries = vec![(0_u32, 0_usize)];
        let mut units = 0;
        for (byte, c) in source.char_indices() {
            units += c.len_utf16() as u32;
            boundaries.push((units, byte + c.len_utf8()));
        }
        for offset in (0..=units + 2).chain([u32::MAX]) {
            let expected = boundaries.iter().find(|(u, _)| *u == offset).map(|(_, b)| *b);
            assert_eq!(utf16_to_byte(&source, offset), expected, "{source:?}, offset={offset}");
        }
    }
}`,
	},
	{
		name: 'simultaneous-utf8-edits',
		signature: 'fn apply_edits(source: &str, edits: &[(usize, usize, &str)]) -> Option<String>',
		prompt: `Fix this Rust function to apply edits whose [start,end) offsets all refer to the ORIGINAL source's UTF-8 bytes. The edits can arrive in any order. Return None for invalid ranges, non-character boundaries, or overlaps. Touching replacements are valid. Zero-length insertions are valid, including multiple at the same offset in input order; an insertion strictly inside a replacement is an overlap. At a replacement's start, insertions come before the replacement; at its end they come after. Preserve unaffected text. Do not panic, mutate the input, use unsafe, or use external crates. Keep the signature.

fn apply_edits(source: &str, edits: &[(usize, usize, &str)]) -> Option<String> {
    let mut output = source.to_string();
    for &(start, end, text) in edits {
        output.replace_range(start..end, text);
    }
    Some(output)
}`,
		tests: String.raw`
#[test]
fn edit_cases() {
    assert_eq!(apply_edits("", &[]).as_deref(), Some(""));
    assert_eq!(apply_edits("abc", &[]).as_deref(), Some("abc"));
    assert_eq!(apply_edits("abcdef", &[(4,6,"!"),(0,1,"XYZ")]).as_deref(), Some("XYZbcd!"));
    assert_eq!(apply_edits("é🦀中", &[(6,9,"Z"),(0,2,"A")]).as_deref(), Some("A🦀Z"));
    assert_eq!(apply_edits("abc", &[(1,1,"X"),(1,1,"Y")]).as_deref(), Some("aXYbc"));
    assert_eq!(apply_edits("abc", &[(1,2,"R"),(2,2,"E"),(1,1,"S")]).as_deref(), Some("aSREc"));
    assert_eq!(apply_edits("abc", &[(0,1,"X"),(1,2,"Y"),(2,3,"Z")]).as_deref(), Some("XYZ"));
    assert_eq!(apply_edits("abc", &[(0,3,"")]).as_deref(), Some(""));
    assert_eq!(apply_edits("", &[(0,0,"a"),(0,0,"b")]).as_deref(), Some("ab"));
    for edits in [vec![(0,2,""),(1,3,"")],vec![(0,3,""),(1,1,"x")],vec![(0,1,""),(0,1,"")],vec![(2,1,"")],vec![(0,4,"")],vec![(usize::MAX,usize::MAX,"")]] {
        assert_eq!(apply_edits("abc", &edits), None, "{edits:?}");
    }
    for edits in [vec![(1,2,"")],vec![(2,3,"")],vec![(3,3,"")],vec![(5,6,"")]] {
        assert_eq!(apply_edits("é🦀中", &edits), None, "{edits:?}");
    }
    let source = "aé🦀中z";
    let boundaries = [0,1,3,7,10,11];
    for &a in &boundaries { for &b in &boundaries { for &c in &boundaries { for &d in &boundaries {
        if a < b && b <= c && c < d {
            let expected = format!("{}X{}Y{}", &source[..a], &source[b..c], &source[d..]);
            assert_eq!(apply_edits(source, &[(c,d,"Y"),(a,b,"X")]), Some(expected));
        }
    }}}}
}`,
	},
	{
		name: 'dependency-cycles',
		signature: 'fn cyclic_nodes(n: usize, edges: &[(usize, usize)]) -> Vec<usize>',
		prompt: `Fix this Rust function. Return exactly the vertices that belong to a directed cycle, sorted ascending without duplicates. A self-loop counts as a cycle. Vertices merely leading into or out of a cycle must be excluded. Vertices are 0..n; ignore edges with either endpoint outside that range. Handle duplicate edges and disconnected graphs. Use O(n + edges.len()) time and memory, no recursion (graphs can contain 100,000 vertices), no unsafe, and only the standard library. Keep the signature.

fn cyclic_nodes(n: usize, edges: &[(usize, usize)]) -> Vec<usize> {
    (0..n).filter(|v| edges.iter().any(|&(a,b)| a == *v && b == *v)).collect()
}`,
		tests: String.raw`
#[test]
fn all_small_graphs() {
    for n in 0..=4 {
        for mask in 0_u64..(1_u64 << (n*n)) {
            let mut reach = vec![vec![false;n];n];
            let mut edges = vec![(n,0),(0,n),(usize::MAX,usize::MAX)];
            for a in 0..n { for b in 0..n {
                if mask & (1 << (a*n+b)) != 0 { reach[a][b] = true; edges.push((a,b)); edges.push((a,b)); }
            }}
            for k in 0..n { for a in 0..n { for b in 0..n {
                reach[a][b] = reach[a][b] || (reach[a][k] && reach[k][b]);
            }}}
            let expected: Vec<_> = (0..n).filter(|&v| reach[v][v]).collect();
            assert_eq!(cyclic_nodes(n, &edges), expected, "n={n} mask={mask}");
        }
    }
}
#[test]
fn deep_graph() {
    let n = 100_000;
    let mut edges: Vec<_> = (1..n).map(|i| (i-1,i)).collect();
    assert!(cyclic_nodes(n, &edges).is_empty());
    edges.push((n-1,n/2));
    assert_eq!(cyclic_nodes(n, &edges), (n/2..n).collect::<Vec<_>>());
}`,
	},
];
