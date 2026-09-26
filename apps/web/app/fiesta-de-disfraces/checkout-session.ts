export function clearCompletedCheckout(storage: Pick<Storage,'removeItem'>) {
  storage.removeItem('feston-payment-session');
  storage.removeItem('feston-payment-active');
}
