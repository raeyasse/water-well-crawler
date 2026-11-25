/** DWR Well Completion Reports map service (public; listed on data.cnra.ca.gov as the dataset's ArcGIS service). */
export const DATASET_URL = "https://data.cnra.ca.gov/dataset/well-completion-reports";
/** State portal page for the same dataset: lists the current service and file downloads, read at run time. */
export const PORTAL_URL = "https://data.ca.gov/dataset/well-completion-reports";
/** Last known service layer, used only when discovery fails. */
export const LAYER_URL =
  "https://utility.arcgis.com/usrsvcs/servers/c074ca40fd684e41babd776eebefd009/rest/services/Environment/i07_WellCompletionReports/MapServer/0";
export const QUERY_URL = `${LAYER_URL}/query`;

/** Below the service's maxRecordCount (2000) to keep responses small. */
export const PAGE_SIZE = 1000;

export interface ArcGisError {
  error: { code: number; message: string; details?: string[] };
}

export interface FeaturePage {
  features: { attributes: Record<string, unknown> }[];
  exceededTransferLimit?: boolean;
}

export interface CountResponse {
  count: number;
}

/** ArcGIS county names are the Census names without " County" (e.g. "Los Angeles"). */
export function serviceCountyName(censusName: string): string {
  return censusName.replace(/ County$/, "");
}

export const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;
