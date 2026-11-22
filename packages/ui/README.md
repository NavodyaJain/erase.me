# @erase/ui
Design tokens and the shared components. Inter, one accent colour (cobalt), and status always with a text label. Source only: no build step.

- `@erase/ui/tokens.css` is the design tokens (copied from `docs/design`). `@erase/ui/styles.css` styles the components from those tokens.
- Components: `Button`, `Chip`, `Card`, `ProgressBar`, `Switch`, `Alert`, `CopyButton`, `TextField`, `TextArea`, `Checkbox`, `Skeleton`, `VisuallyHidden`.
- Accessible by default: visible focus ring, 44px touch targets, labelled controls, `role=alert` only for problems, and reduced motion respected. Tests include axe checks.
- Components take their text from the caller. All user-facing copy lives in the app (`apps/web/src/copy`), where a test checks it against the wording rules.
