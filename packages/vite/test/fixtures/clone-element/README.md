<!-- human -->
# clone-element

`React.cloneElement(c, {...})` produces JSX at runtime but has no lexical JSX. The visitor finds NO JSX opening elements — `Wrap` appears in no manifest component list, and the batch is empty. This documents the limitation: cloneElement-created elements can't be tagged statically.
