interface Rule {
  label: string;
  test: (password: string) => boolean;
}

// The backend only requires length >= 8 (see backend/app/schemas.py -
// RegisterRequest.password). Composition rules like "must have a symbol"
// are shown here only as UI guidance/encouragement, not enforced server-
// side: current guidance (NIST 800-63B) favors length over forced
// character-class mixing, which tends to push people toward predictable
// substitutions ("password" -> "Passw0rd!") rather than real strength.
const rules: Rule[] = [
  { label: "At least 8 characters", test: (p) => p.length >= 8 },
  { label: "One uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { label: "One lowercase letter", test: (p) => /[a-z]/.test(p) },
  { label: "One number", test: (p) => /[0-9]/.test(p) },
  { label: "One symbol", test: (p) => /[^A-Za-z0-9]/.test(p) },
];

export default function PasswordStrength({ password }: { password: string }) {
  if (!password) return null;

  const passed = rules.filter((rule) => rule.test(password)).length;
  const strengthLabel = ["Very weak", "Weak", "Fair", "Good", "Strong", "Excellent"][passed];

  return (
    <div className="password-strength">
      <div className="strength-bar">
        <div className={`strength-bar-fill strength-${passed}`} style={{ width: `${(passed / rules.length) * 100}%` }} />
      </div>
      <p className="hint">{strengthLabel}</p>
      <ul className="strength-checklist">
        {rules.map((rule) => (
          <li key={rule.label} className={rule.test(password) ? "met" : ""}>
            {rule.test(password) ? "✓" : "○"} {rule.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
