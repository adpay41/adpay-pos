/**
 * Everything the customer reads on the second screen, in one place (P9). Rules from the Bible
 * (1.5, Part 4): the customer never sees a processor's name, a spinner, or "system down"; both
 * prices are always shown before paying. This is also where the eight languages of P18 plug in.
 */
export const CUSTOMER_COPY = {
  welcome_note: 'Cash and card prices are both shown before you pay.',
  pay_cash: 'Pay with cash',
  pay_card: 'Pay with card',
  tap_card: 'Tap, insert or swipe your card on the card machine',
  card_amount: 'Card total',
  paid_so_far: 'Paid so far',
  approved: 'Approved — thank you!',
  declined: 'That card didn’t go through. Try another card, or pay with cash.',
  thanks: 'Thank you!',
  your_change: 'Your change',
  paid: 'Paid',
} as const;
