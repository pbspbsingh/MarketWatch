import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { AppSettingsProvider } from "./app/AppSettings";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./shared/queryClient";
import "./app/styles.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AppSettingsProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppSettingsProvider>
  </QueryClientProvider>,
);
