// Paid services sold by the Overseer demo API. Add a service here and it is listed and paywalled automatically.
import type { Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import type { PricedService } from "./payments.js";

export interface Service extends PricedService {
  method: "GET" | "POST";
  path: string;
  /** Human-readable parameter docs shown in the service listing. */
  params: Record<string, string>;
  /** Runs before payment is requested, so bad requests are never charged. Returns an error message or null. */
  validate(req: Request): string | null;
  handle(req: Request, res: Response): Promise<void>;
}

const WMO_CODES: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "light showers", 81: "showers", 82: "violent showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

const weather: Service = {
  id: "weather",
  method: "GET",
  path: "/api/weather",
  priceUsdc: "0.01",
  description: "Current weather and the next 6 hours for any city",
  params: { city: "City name, e.g. Dublin" },
  validate: (req) => (typeof req.query.city === "string" && req.query.city.trim() ? null : "Query parameter `city` is required"),
  async handle(req, res) {
    const city = String(req.query.city);
    const geo = (await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)).json()) as {
      results?: { name: string; country: string; latitude: number; longitude: number }[];
    };
    const place = geo.results?.[0];
    if (!place) {
      res.status(404).json({ error: `No city called "${city}" found` });
      return;
    }
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m" +
      "&hourly=temperature_2m,precipitation_probability&forecast_hours=6&timezone=auto";
    const wx = (await (await fetch(url)).json()) as {
      current: { time: string; temperature_2m: number; apparent_temperature: number; precipitation: number; weather_code: number; wind_speed_10m: number };
      hourly: { time: string[]; temperature_2m: number[]; precipitation_probability: number[] };
    };
    res.json({
      place: `${place.name}, ${place.country}`,
      now: {
        time: wx.current.time,
        conditions: WMO_CODES[wx.current.weather_code] ?? `WMO code ${wx.current.weather_code}`,
        temperatureC: wx.current.temperature_2m,
        feelsLikeC: wx.current.apparent_temperature,
        precipitationMm: wx.current.precipitation,
        windKmh: wx.current.wind_speed_10m,
      },
      next6Hours: wx.hourly.time.map((time, i) => ({
        time,
        temperatureC: wx.hourly.temperature_2m[i],
        chanceOfRainPct: wx.hourly.precipitation_probability[i],
      })),
      source: "Open-Meteo",
      payment: res.locals.payment,
    });
  },
};

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

interface AnalyzeBody {
  prompt: string;
  projectTree?: string;
  readme?: string;
}

const analyze: Service = {
  id: "analyze",
  method: "POST",
  path: "/api/analyze",
  priceUsdc: "0.25",
  description: "Recommends existing APIs that fit a project's scope and goals",
  params: {
    prompt: "What you're building, e.g. \"a Discord bot that tracks crypto prices\"",
    projectTree: "(optional) the project's file tree, for extra context",
    readme: "(optional) the project's README, for extra context",
  },
  validate: (req) => {
    const { prompt } = (req.body ?? {}) as Partial<AnalyzeBody>;
    return typeof prompt === "string" && prompt.trim() ? null : "Body field `prompt` is required";
  },
  async handle(req, res) {
    const { prompt, projectTree, readme } = req.body as AnalyzeBody;
    const context = [`Project: ${prompt}`, projectTree && `File tree:\n${projectTree}`, readme && `README:\n${readme}`]
      .filter(Boolean)
      .join("\n\n");

    const message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system:
        "You recommend existing, real, currently-available web APIs that fit a software project's scope and goals. " +
        "Respond with ONLY a JSON array (no prose, no markdown fences). Each item: " +
        '{"name": string, "whatItDoes": string, "whyItFits": string, "pricingAndAuth": string, "docsUrl": string, "agentPayable": string}. ' +
        '"agentPayable" says whether an AI agent could pay for this API per request today (e.g. via x402 / stablecoins), or whether it needs a conventional account, API key, or card. ' +
        "Recommend 3 to 6 real APIs. Never invent an API that doesn't exist.",
      messages: [{ role: "user", content: context }],
    });

    const text = message.content.find((block) => block.type === "text")?.text ?? "[]";
    let recommendations: unknown;
    try {
      recommendations = JSON.parse(text);
    } catch {
      res.status(502).json({ error: "Claude returned a response that wasn't valid JSON", raw: text });
      return;
    }

    res.json({ recommendations, payment: res.locals.payment });
  },
};

export const services: Service[] = [weather, analyze];
