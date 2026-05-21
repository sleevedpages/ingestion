import type { RateLimitedClient } from './http.js';
import { logger } from './logger.js';
import type { TcgApiResponse, TcgCategory } from '../types/tcgcsv.js';

// All fields from the matched TcgCategory, ready for upsert
export interface ResolvedCategory {
  categoryId: number;
  name: string;
  displayName: string;
  modifiedOn: string;
  imageUrl: string;
  seoText: string | null;
  isDirectBrand: boolean;
}

export interface SupportedTcg {
  /** Human label used as the map key and in log output */
  label: string;
  /** Search terms tried in order; first substring match wins */
  terms: readonly string[];
}

export async function loadSupportedTcgs(db: D1Database): Promise<SupportedTcg[]> {
  const { results } = await db
    .prepare('SELECT label, terms FROM tcg_supported_games WHERE enabled = 1 ORDER BY label')
    .all<{ label: string; terms: string }>();
  return results.map((r) => ({
    label: r.label,
    terms: JSON.parse(r.terms) as string[],
  }));
}

function matchCategory(
  results: TcgCategory[],
  term: string
): TcgCategory | undefined {
  const lower = term.toLowerCase();
  return results.find(
    (cat) =>
      cat.name.toLowerCase().includes(lower) ||
      (cat.displayName ?? '').toLowerCase().includes(lower)
  );
}

export async function resolveCategories(
  httpClient: RateLimitedClient,
  supportedTcgs: SupportedTcg[]
): Promise<Map<string, ResolvedCategory>> {
  logger.debug('Fetching TCG categories from TCGCSV');
  const data = await httpClient.get<TcgApiResponse<TcgCategory>>('/tcgplayer/categories');

  const resolved = new Map<string, ResolvedCategory>();

  for (const tcg of supportedTcgs) {
    let match: TcgCategory | undefined;
    let matchedTerm: string | undefined;

    for (const term of tcg.terms) {
      match = matchCategory(data.results, term);
      if (match) {
        matchedTerm = term;
        break;
      }
    }

    if (match && matchedTerm) {
      const usedFallback = matchedTerm !== tcg.terms[0];
      if (usedFallback) {
        logger.warn('Resolved category using fallback term — primary term not found', {
          label: tcg.label,
          primaryTerm: tcg.terms[0],
          matchedTerm,
          categoryId: match.categoryId,
          apiName: match.name,
        });
      } else {
        logger.info('Resolved category', {
          label: tcg.label,
          categoryId: match.categoryId,
          apiName: match.name,
        });
      }
      resolved.set(tcg.label, {
        categoryId:    match.categoryId,
        name:          match.name,
        displayName:   match.displayName,
        modifiedOn:    match.modifiedOn,
        imageUrl:      match.image,
        seoText:       match.seoText,
        isDirectBrand: match.isDirectBrand,
      });
    } else {
      logger.warn(
        'Could not resolve TCG category — check /tcgplayer/categories and update the match terms in the admin TCG Sync panel.',
        {
          label: tcg.label,
          termsAttempted: tcg.terms,
          availableCategories: data.results.map((c) => c.name),
        }
      );
    }
  }

  return resolved;
}
