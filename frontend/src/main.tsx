import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { AppSettingsProvider } from "./app/AppSettings";
import "./app/styles.css";

createRoot(document.getElementById("root")!).render(
  <AppSettingsProvider>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </AppSettingsProvider>,
);
