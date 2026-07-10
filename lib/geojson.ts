import type { FeatureCollection, Point, Feature } from "geojson";
import type { Facility } from "@/lib/schema";
import type { Status } from "@/lib/status";

export interface FacilityFeatureProps {
  id: string;
  name: string;
  operator: string;
  status: Status;
  aiClassification?: "confirmed" | "likely" | "mixed_use";
  confidence: "confirmed" | "reported" | "rumored";
  state: string;
  capacityPlanned?: number;
  capacityOperational?: number;
}

export function facilitiesToGeoJSON(
  facilities: Facility[]
): FeatureCollection<Point, FacilityFeatureProps> {
  const features: Feature<Point, FacilityFeatureProps>[] = facilities.map(
    (f) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [f.location.lon, f.location.lat],
      },
      properties: {
        id: f.id,
        name: f.name,
        operator: f.operator,
        status: f.status,
        aiClassification: f.aiClassification,
        confidence: f.confidence,
        state: f.location.state,
        capacityPlanned: f.capacityMw?.planned,
        capacityOperational: f.capacityMw?.operational,
      },
    })
  );

  return {
    type: "FeatureCollection",
    features,
  };
}
