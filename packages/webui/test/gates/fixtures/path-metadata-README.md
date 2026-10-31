# Frozen path metadata oracle

`path-metadata-f00.json` records classifications and direction decisions computed by
`scripts/lib/webui-dependency-rules.mjs` at `f00b1268c28ad15054a8882620c3fb08beb86d58`.
The file records that source's SHA-256. Its path corpus includes every current TypeScript,
TSX and CSS source plus future/unknown paths. This is an executable test fixture, not a
current implementation report.

Do not regenerate expectations from the current classifier. For a new source path, run the
frozen baseline classifier against the path after stripping only `.public` before its
TypeScript suffix. Review any mismatch separately. The declared publication delta adds a
`published-` role prefix and preserves the pre-publication layer; publication restrictions
have their own positive/negative dependency-gate fixtures. The direction matrix is an
independent baseline and is not inferred from paths or current role metadata.
