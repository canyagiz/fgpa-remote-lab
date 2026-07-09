import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { AuthDialogProvider } from "./context/AuthDialogContext";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AuthDialogProvider>
          <App />
        </AuthDialogProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
