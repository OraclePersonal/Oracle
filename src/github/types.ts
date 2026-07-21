export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PR {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  headRepo?: RepoRef;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  closedAt?: string;
  labels: string[];
  url: string;
}

export interface PRFile {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
}

export interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  labels: string[];
  url: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface ReviewInput {
  body: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
}

export interface Branch {
  name: string;
  default: boolean;
}

export interface SearchResult {
  path: string;
  repo: string;
  matches: string[];
}
