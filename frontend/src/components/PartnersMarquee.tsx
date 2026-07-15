import { partners } from "../config/partners";

// Duplicated so the track can loop seamlessly: translating the first copy
// out by exactly its own width reveals the identical second copy underneath.
export default function PartnersMarquee() {
  return (
    <div className="mt-16">
      <p className="text-center text-base uppercase tracking-wide text-muted-foreground">
        In partnership with
      </p>
      <div className="partners-marquee-mask relative mt-6 overflow-hidden">
        <div className="partners-marquee-track flex w-max items-center gap-16">
          {[...partners, ...partners].map((partner, index) => (
            <a
              key={`${partner.name}-${index}`}
              href={partner.url}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0"
            >
              <img
                src={partner.logo}
                alt={partner.name}
                className={partner.logoClassName ?? "h-20 w-auto"}
              />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
