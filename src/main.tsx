import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StreamApp } from "./StreamApp";
import { Route, Switch } from "wouter";
import { WatchApp } from "./WatchApp";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <Switch>
      <Route path="/" component={StreamApp} />
      <Route path="/watch" component={WatchApp} />
    </Switch>
  </StrictMode>,
);
