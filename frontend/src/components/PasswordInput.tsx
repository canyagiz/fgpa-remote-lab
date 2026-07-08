import { KeyboardEvent, useState } from "react";

interface PasswordInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
}

export default function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  minLength,
  required,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);

  function handleKeyEvent(e: KeyboardEvent<HTMLInputElement>) {
    // getModifierState needs a real KeyboardEvent, available on both
    // keydown and keyup - checking on both catches toggling Caps Lock
    // itself, not just typing while it's already on.
    setCapsLockOn(e.getModifierState("CapsLock"));
  }

  return (
    <div className="password-input">
      <div className="password-input-row">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyEvent}
          onKeyUp={handleKeyEvent}
          autoComplete={autoComplete}
          minLength={minLength}
          required={required}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          tabIndex={-1}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {capsLockOn && <p className="caps-lock-warning">Caps Lock is on</p>}
    </div>
  );
}
