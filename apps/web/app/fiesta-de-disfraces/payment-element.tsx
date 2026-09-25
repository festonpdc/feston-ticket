'use client';

import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { useMemo, useState } from 'react';

type Props = {
  clientSecret: string;
  returnUrl: string;
  total: number;
  onProcessing: () => void;
  onFailure: (message: string) => void;
};

export function StripeCardCheckout(props: Props) {
  const stripe = useMemo(() => loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ''), []);
  return (
    <Elements stripe={stripe} options={{
      clientSecret: props.clientSecret,
      appearance: {
        theme: 'night',
        variables: {
          colorPrimary: '#c83f3f', colorBackground: '#171b16', colorText: '#f4ead3',
          colorDanger: '#ef6a62', colorTextSecondary: '#c9bea8', borderRadius: '2px',
          fontFamily: 'Arial, sans-serif', spacingUnit: '4px',
        },
        rules: {
          '.Input': { border: '1px solid rgba(244, 234, 211, 0.22)', boxShadow: 'none' },
          '.Input:focus': { border: '1px solid #c83f3f', boxShadow: '0 0 0 1px #c83f3f' },
        },
      },
    }}>
      <CardForm {...props} />
    </Elements>
  );
}

function CardForm({ total, returnUrl, onProcessing, onFailure }: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    if (!stripe || !elements || !ready || submitting) return;
    setSubmitting(true);
    setError('');
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: 'if_required',
    });
    if (result.error) {
      const message = result.error.type === 'validation_error'
        ? 'Revisá los datos de la tarjeta.'
        : 'El pago no pudo completarse. Intentá nuevamente.';
      setError(message);
      setSubmitting(false);
      onFailure(message);
      return;
    }
    onProcessing();
  }

  return (
    <div className="stripe-card-checkout" aria-busy={!ready || submitting}>
      <p className="section-kicker">PAGO SEGURO</p>
      <PaymentElement options={{ layout: 'accordion', paymentMethodOrder: ['card'] }} onReady={() => setReady(true)} />
      {!ready && <p className="payment-loading" role="status">CARGANDO PAGO SEGURO...</p>}
      {error && <p className="payment-error" role="alert">{error}</p>}
      <button className="primary-cta" type="button" disabled={!ready || submitting || !stripe || !elements} onClick={confirm}>
        {submitting ? 'PROCESANDO PAGO...' : `PAGAR ${money(total)} MXN`}
      </button>
    </div>
  );
}

function money(value: number) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(value / 100);
}
