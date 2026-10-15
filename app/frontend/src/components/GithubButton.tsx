import { Github, Heart, Star } from "lucide-react";

export const REPO_URL = "https://github.com/emremrangz/emremote";

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n);
}

/** Link to the maintainer's GitHub Sponsors page. */
export function SponsorButton() {
  return (
    <a
      href="https://github.com/sponsors/emremrangz"
      target="_blank"
      rel="noopener noreferrer"
      className="mr-1 flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-fg"
      title="Support emremote on GitHub Sponsors"
    >
      <Heart className="h-3.5 w-3.5 text-danger" /> <span className="hidden sm:inline">Sponsor</span>
    </a>
  );
}

/** Link to the project on GitHub, with the star count when the server knows it. */
export function GithubButton({ stars }: { stars?: number }) {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="mr-1 flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-muted transition-colors hover:border-border-strong hover:text-fg"
      title="emremote on GitHub"
    >
      <Github className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">GitHub</span>
      {stars ? (
        <span className="flex items-center gap-0.5 border-l border-border pl-1.5">
          <Star className="h-3 w-3 text-warning" /> {compact(stars)}
        </span>
      ) : null}
    </a>
  );
}
