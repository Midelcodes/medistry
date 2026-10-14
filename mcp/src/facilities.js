// SYNTHETIC facilities for demo/evaluation. Not real hospitals. Nigeria only (single-country scope).
export const FACILITIES = [
  { id: "NG-LAG-001", name: "Demo General Hospital Ikeja", state: "Lagos", level: "tertiary",
    lat: 6.60, lon: 3.35, capabilities: ["emergency", "icu", "cardiology", "trauma_surgery", "obstetrics", "neurology", "haematology"], icuBedsFree: 2, edOpen: true },
  { id: "NG-LAG-002", name: "Demo Teaching Hospital Idi-Araba", state: "Lagos", level: "tertiary",
    lat: 6.52, lon: 3.36, capabilities: ["emergency", "icu", "cardiology", "obstetrics", "neurology", "burns", "haematology"], icuBedsFree: 0, edOpen: true },
  { id: "NG-LAG-003", name: "Demo Primary Health Centre Surulere", state: "Lagos", level: "primary",
    lat: 6.50, lon: 3.35, capabilities: ["general"], icuBedsFree: 0, edOpen: true },
  { id: "NG-OGN-001", name: "Demo General Hospital Abeokuta", state: "Ogun", level: "secondary",
    lat: 7.16, lon: 3.35, capabilities: ["emergency", "obstetrics", "general_surgery"], icuBedsFree: 1, edOpen: true },
  { id: "NG-FCT-001", name: "Demo National Hospital Abuja", state: "FCT", level: "tertiary",
    lat: 9.05, lon: 7.49, capabilities: ["emergency", "icu", "cardiology", "trauma_surgery", "obstetrics", "neurology", "burns", "haematology"], icuBedsFree: 3, edOpen: true },
  { id: "NG-FCT-002", name: "Demo District Hospital Garki", state: "FCT", level: "secondary",
    lat: 9.03, lon: 7.50, capabilities: ["emergency", "obstetrics", "general_surgery"], icuBedsFree: 0, edOpen: false },
];

export const LEVEL_RANK = { primary: 0, secondary: 1, tertiary: 2 };

export function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
