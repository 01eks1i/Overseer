// Paid services sold by the Overseer demo API. Add a service here and it is listed and paywalled automatically.
import type { Request, Response } from "express";
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

export const services: Service[] = [weather];
