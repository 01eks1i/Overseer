export interface CatalogApi {
  name: string;
  category: string;
  description: string;
  docsUrl: string;
  endpoint?: string;
  pricing?: string;
  authentication?: string;
  agentPayable?: string;
}

export const apiCatalog: CatalogApi[] = [
  {
    name: "Open-Meteo Weather API",
    category: "Weather",
    description: "Free, open-source weather API with no API key required for non-commercial use.",
    docsUrl: "https://open-meteo.com/en/docs",
    endpoint: "https://api.open-meteo.com/v1/forecast",
    pricing: "Free for non-commercial use, paid tiers available.",
    authentication: "None required for basic access.",
    agentPayable: "No — free or requires conventional account."
  },
  {
    name: "Frankfurter Currency API",
    category: "Currency",
    description: "Open-source API for current and historical foreign exchange rates published by the European Central Bank.",
    docsUrl: "https://www.frankfurter.app/docs/",
    endpoint: "https://api.frankfurter.app/latest",
    pricing: "Free and open-source.",
    authentication: "None required.",
    agentPayable: "No — completely free."
  },
  {
    name: "Mapbox Maps API",
    category: "Maps/Geocoding",
    description: "Powerful mapping and location cloud platform for developers.",
    docsUrl: "https://docs.mapbox.com/api/",
    pricing: "Pay-as-you-go, generous free tier.",
    authentication: "API Key required.",
    agentPayable: "No — requires API key/account."
  },
  {
    name: "Anthropic Claude API",
    category: "AI/Document Services",
    description: "API for accessing Claude, a next-generation AI assistant.",
    docsUrl: "https://docs.anthropic.com/claude/docs",
    pricing: "Per-token pricing.",
    authentication: "API Key required.",
    agentPayable: "No — requires API key/account."
  },
  {
    name: "Overseer Weather API (Demo)",
    category: "Weather",
    description: "Demo weather API running on the local project that supports agentic microtransactions.",
    docsUrl: "http://localhost:4020/api/weather",
    pricing: "$0.01 USDC per request.",
    authentication: "HTTP 402 + X-PAYMENT + Solana (x402-style).",
    agentPayable: "Yes — supports per-request payment via crypto."
  }
];
