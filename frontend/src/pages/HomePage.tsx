import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function HomePage() {
  const { user } = useAuth();

  return (
    <div className="home">
      <section className="hero">
        <img src="/logo.png" alt="FPGA Vision" className="hero-logo" />
        <h1>FPGA Remote Lab</h1>
        <p className="hero-tagline">
          Reserve real FPGA hardware and run your experiments remotely - no need to be on
          campus.
        </p>
        <div className="hero-actions">
          {user ? (
            <Link to="/dashboard" className="btn-primary">
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link to="/register" className="btn-primary">
                Get started
              </Link>
              <Link to="/login" className="btn-secondary">
                Sign in
              </Link>
            </>
          )}
        </div>
      </section>

      {/* Placeholder content - to be replaced once the hardware-access
          layer and lab catalog (Faz 4/5) land. */}
      <section className="feature-grid">
        <div className="feature-card">
          <h3>Reserve a slot</h3>
          <p>Book a lab for a specific time, or join the queue for immediate access.</p>
        </div>
        <div className="feature-card">
          <h3>Work from anywhere</h3>
          <p>Access lab hardware from your browser - on campus or off.</p>
        </div>
        <div className="feature-card">
          <h3>Secure by default</h3>
          <p>Email verification on signup and session-based authentication protect every account.</p>
        </div>
      </section>
    </div>
  );
}
