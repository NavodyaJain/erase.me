# Tokens

`tokens.json` and `tokens.css` are copies of `docs/design/tokens.json` and `docs/design/tokens.css`.
`docs/design/` is the visual reference; apps import tokens from here (`@erase/ui/tokens/tokens.css`).
If you change a token, change it in both places in the same commit.
Note: `#E7EAF1` is treated as `--color-line` (same as `#E6E8EC`). Snap off-scale sizes and radii to the nearest token.
