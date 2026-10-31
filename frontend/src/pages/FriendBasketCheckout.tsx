import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, inr } from '../api';

interface CheckoutItem { name: string; quantity: number; unitPricePaise: number }
interface CheckoutParticipant { id: string; name: string; amountPaise: number; items: CheckoutItem[] }
interface CheckoutState { restaurantName: string; providerName: string; address: string; participants: CheckoutParticipant[] }
interface GeneratedQr { participantId: string; name: string; amountPaise: number; imageUrl: string; status: string; error?: string }

export default function FriendBasketCheckout() {
  const location = useLocation();
  const navigate = useNavigate();
  const checkout = location.state as CheckoutState | null;
  const [payments, setPayments] = useState<GeneratedQr[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  if (!checkout || !Array.isArray(checkout.participants) || !checkout.participants.length) {
    return <div className="feature-page"><div className="state">Checkout details are missing. <Link to="/shared-cart">Return to Basket Split</Link></div></div>;
  }

  const checkoutData = checkout;
  const totalPaise = checkoutData.participants.reduce((sum, person) => sum + person.amountPaise, 0);
  async function generatePaymentQrs() {
    const alreadyCreated = new Set(payments.filter(payment => payment.status === 'created').map(payment => payment.participantId));
    const missingParticipants = checkoutData.participants.filter(person => !alreadyCreated.has(person.id));
    if (!missingParticipants.length) return;
    setGenerating(true); setError('');
    try {
      const result = await api<{ payments: GeneratedQr[] }>('/demo-payments/qrs', {
        method: 'POST',
        body: JSON.stringify({ participants: missingParticipants.map(({ id, name, amountPaise }) => ({ id, name, amountPaise })) }),
      });
      setPayments(current => [...current.filter(payment => payment.status === 'created'), ...result.payments]);
      const failures = result.payments.filter(payment => payment.status !== 'created');
      if (failures.length) setError(`${failures.length} test QR${failures.length === 1 ? '' : 's'} could not be created. Retry for those participants after checking the test payment configuration.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not generate payment QRs.');
    } finally { setGenerating(false); }
  }

  return <div className="feature-page friend-checkout-page">
    <div className="eyebrow">BASKET SPLIT · CHECKOUT</div>
    <div className="feature-hero"><div><span className="kicker">TEST PAYMENT CHECKOUT</span><h1>Everyone pays their own food share.</h1><p>{checkout.restaurantName} · {checkout.providerName}</p></div></div>
    <div className="friend-checkout-layout">
      <section className="card"><h2>Order and delivery</h2><p><b>Shared address</b><br />{checkout.address}</p><div className="friend-checkout-people">{checkout.participants.map(person => <article className="friend-checkout-person" key={person.id}>
        <div className="section-heading"><h3>{person.name}</h3><strong>{inr(person.amountPaise / 100)}</strong></div>
        {person.items.map((item, index) => <div className="share-row" key={`${person.id}-${item.name}-${index}`}><span>{item.name} × {item.quantity}</span><span>{inr(item.unitPricePaise * item.quantity / 100)}</span></div>)}
      </article>)}</div><div className="share-row friend-checkout-total"><strong>Food items total</strong><strong>{inr(totalPaise / 100)}</strong></div>
        <p className="muted small">Charges are split by the selected food items. Delivery, tax and discounts are excluded in this friend demo.</p>
      </section>
      <section className="card"><span className="kicker">PAYMENT REQUESTS</span><h2>{checkout.participants.length} individual test QR{checkout.participants.length === 1 ? '' : 's'}</h2>
        <p className="muted">Generate a separate fixed-amount Razorpay test QR for each participant. Only configured <code>rzp_test_</code> credentials are accepted; live payments are disabled.</p>
        <button type="button" className="btn" disabled={generating || payments.length === checkout.participants.length && payments.every(payment => payment.status === 'created')} onClick={() => void generatePaymentQrs()}>{generating ? 'Generating test QRs…' : payments.length ? 'Retry failed QRs' : 'Generate payment QRs'}</button>
        {error && <p className="state error" role="alert">{error}</p>}
        {payments.length > 0 && <div className="friend-checkout-qr-grid">{payments.map(payment => <article className="friend-checkout-qr" key={payment.participantId}>
          {payment.status === 'created' && payment.imageUrl ? <img src={payment.imageUrl} alt={`Razorpay test payment QR for ${payment.name}`} /> : <div className="friend-checkout-qr-error">QR unavailable</div>}
          <div><span className="kicker">RAZORPAY TEST QR</span><h3>{payment.name}</h3><strong>{inr(payment.amountPaise / 100)}</strong><p className="muted small">{payment.status === 'created' ? 'Fixed amount · test mode' : payment.error || 'Generation failed'}</p></div>
        </article>)}</div>}
        <p className="muted small">These are genuine Razorpay test-mode payment requests, if generated. They are not live charges and are not connected to a restaurant order.</p>
      </section>
    </div>
    <button type="button" className="btn ghost" onClick={() => navigate('/shared-cart', { state: { reopenFriendDemo: true } })}>Back to Basket Split</button>
  </div>;
}
