import { PricingCard } from './PricingCard'

export function PricingSection() {
  return (
    <section>
      <PricingCard tier="Free" price={0} />
      <PricingCard tier="Pro" price={10} />
      <PricingCard tier="Team" price={30} />
      <PricingCard tier="Enterprise" price={100} />
    </section>
  )
}
