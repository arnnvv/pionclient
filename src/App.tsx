import { useState, type JSX } from "react";

export function App(): JSX.Element {
  const [count, setCount] = useState(0);

  return (
    <button type="button" onClick={() => setCount((count) => count + 1)}>
      count is {count}
    </button>
  );
}
