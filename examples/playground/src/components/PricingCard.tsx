export function PricingCard(props: { tier: string; price: number }) {
  return (
    <div className="border p-4 rounded">
      <h3>{props.tier}</h3>
      <div>${props.price}/mo</div>
    </div>
  )
}
