export interface Icon {
  href: string;
  sizes: string;
}

export interface ResponseInfo {
  url: string;
  host: string;
  status: number;
  statusText: string;
  icons: Icon[];
  duration?: string;
}

// Defines a scored icon structure for sorting
export interface ScoredIcon {
  icon: Icon;
  score: number;
}