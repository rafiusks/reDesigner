<!-- human -->
# compiler-hoist-order

Simulates post-React-Compiler hoisted JSX (`_c[0] = <div />`). Verifies our Babel pass still tags the opening element inside the assignment (`<div>` attributed to `Card`). React Compiler cooperation is behavior spec §2.
