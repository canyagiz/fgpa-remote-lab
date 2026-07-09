import { createContext, ReactNode, useContext, useState } from "react";

type AuthDialogMode = "login" | "register" | null;

interface AuthDialogContextValue {
  mode: AuthDialogMode;
  openLogin: () => void;
  openRegister: () => void;
  close: () => void;
}

const AuthDialogContext = createContext<AuthDialogContextValue | null>(null);

export function AuthDialogProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AuthDialogMode>(null);

  return (
    <AuthDialogContext.Provider
      value={{
        mode,
        openLogin: () => setMode("login"),
        openRegister: () => setMode("register"),
        close: () => setMode(null),
      }}
    >
      {children}
    </AuthDialogContext.Provider>
  );
}

export function useAuthDialog() {
  const ctx = useContext(AuthDialogContext);
  if (!ctx) throw new Error("useAuthDialog must be used within AuthDialogProvider");
  return ctx;
}
