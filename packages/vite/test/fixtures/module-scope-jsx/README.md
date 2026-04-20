<!-- human -->
# module-scope-jsx

Module-scope JSX. Manifest attributes `<App />` to the synthetic `(module)` component. Per spec §1.4.5, the `data-redesigner-loc` attribute is NOT injected on module-scope elements — the DOM has no marker. Consumers hit-test against `<App>` or deeper.
