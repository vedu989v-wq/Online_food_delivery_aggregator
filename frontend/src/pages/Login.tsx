import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    window.setTimeout(() => navigate('/'), 500);
  }

  return (
    <main className="login-page">
      <section className="login-shell" aria-labelledby="login-title">
        <div className="login-intro">
          <Link to="/" className="login-brand"><span>buy</span>hatke <b>food</b></Link>
          <p className="eyebrow">COMPARE BEFORE YOU ORDER</p>
          <h1 id="login-title">Your smarter food<br />ordering starts here.</h1>
          <p className="login-copy">Sign in to compare prices, delivery fees, ratings, and offers across your favourite food apps.</p>
          <div className="login-perks" aria-label="Benefits of signing in">
            <div><span className="perk-icon">₹</span><span><strong>Find the best price</strong><small>See the real total before checkout.</small></span></div>
            <div><span className="perk-icon">★</span><span><strong>Save your favourites</strong><small>Keep restaurants and dishes close.</small></span></div>
          </div>
        </div>

        <div className="login-card">
          <div className="login-card-head">
            <h2>Welcome back</h2>
            <p>Log in to continue comparing.</p>
          </div>
          <form onSubmit={handleSubmit} className="login-form">
            <label htmlFor="email">Email address</label>
            <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required autoComplete="email" />
            <div className="label-row"><label htmlFor="password">Password</label><a href="#forgot">Forgot password?</a></div>
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" required minLength={6} autoComplete="current-password" />
            <button className="login-submit" type="submit">{submitted ? 'Signing you in…' : 'Log in'}</button>
          </form>
          <div className="login-divider"><span>or</span></div>
          <button className="social-button" type="button" onClick={() => setSubmitted(true)}><span className="google-mark">G</span> Continue with Google</button>
          <p className="login-signup">New to buyhatke food? <a href="#signup">Create an account</a></p>
          <p className="login-terms">By continuing, you agree to our <a href="#terms">Terms</a> and <a href="#privacy">Privacy Policy</a>.</p>
        </div>
      </section>
    </main>
  );
}
