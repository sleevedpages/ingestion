/**
 * Mapping from TCGPlayer set names to Scrydex set IDs.
 * Scrydex CDN: https://images.scrydex.com/pokemon/{setId}-{formattedNumber}/large
 *
 * Derived from Scrydex's public set listing. Keys are the canonical set names
 * as stored in tcg_sets.name (TCGPlayer naming convention).
 */

export const POKEMON_SET_MAP: Record<string, string> = {
  // Base / Classic era
  'Base Set':                          'base1',
  'Jungle':                            'jungle',
  'Fossil':                            'fossil',
  'Base Set 2':                        'base2',
  'Team Rocket':                       'teamrocket',
  'Gym Heroes':                        'gym1',
  'Gym Challenge':                     'gym2',

  // Neo era
  'Neo Genesis':                       'neo1',
  'Neo Discovery':                     'neo2',
  'Neo Revelation':                    'neo3',
  'Neo Destiny':                       'neo4',

  // Legendary Collection / e-Card
  'Legendary Collection':              'base6',
  'Expedition Base Set':               'ecard1',
  'Aquapolis':                         'ecard2',
  'Skyridge':                          'ecard3',

  // EX era
  'EX Ruby & Sapphire':                'ex1',
  'EX Sandstorm':                      'ex2',
  'EX Dragon':                         'ex3',
  'EX Team Magma vs Team Aqua':        'ex4',
  'EX Hidden Legends':                 'ex5',
  'EX FireRed & LeafGreen':            'ex6',
  'EX Team Rocket Returns':            'ex7',
  'EX Deoxys':                         'ex8',
  'EX Emerald':                        'ex9',
  'EX Unseen Forces':                  'ex10',
  'EX Delta Species':                  'ex11',
  'EX Legend Maker':                   'ex12',
  'EX Holon Phantoms':                 'ex13',
  'EX Crystal Guardians':              'ex14',
  'EX Dragon Frontiers':               'ex15',
  'EX Power Keepers':                  'ex16',

  // Diamond & Pearl era
  'Diamond & Pearl':                   'dp1',
  'Mysterious Treasures':              'dp2',
  'Secret Wonders':                    'dp3',
  'Great Encounters':                  'dp4',
  'Majestic Dawn':                     'dp5',
  'Legends Awakened':                  'dp6',
  'Stormfront':                        'dp7',

  // Platinum era
  'Platinum':                          'pl1',
  'Rising Rivals':                     'pl2',
  'Supreme Victors':                   'pl3',
  'Arceus':                            'pl4',

  // HeartGold SoulSilver era
  'HeartGold & SoulSilver':            'hgss1',
  'Unleashed':                         'hgss2',
  'Undaunted':                         'hgss3',
  'Triumphant':                        'hgss4',
  'Call of Legends':                   'col1',

  // Black & White era
  'Black & White':                     'bw1',
  'Emerging Powers':                   'bw2',
  'Noble Victories':                   'bw3',
  'Next Destinies':                    'bw4',
  'Dark Explorers':                    'bw5',
  'Dragons Exalted':                   'bw6',
  'Dragon Vault':                      'dv1',
  'Boundaries Crossed':                'bw7',
  'Plasma Storm':                      'bw8',
  'Plasma Freeze':                     'bw9',
  'Plasma Blast':                      'bw10',
  'Legendary Treasures':               'bw11',

  // XY era
  'XY':                                'xy1',
  'Flashfire':                         'xy2',
  'Furious Fists':                     'xy3',
  'Phantom Forces':                    'xy4',
  'Primal Clash':                      'xy5',
  'Double Crisis':                     'dc1',
  'Roaring Skies':                     'xy6',
  'Ancient Origins':                   'xy7',
  'BREAKthrough':                      'xy8',
  'BREAKpoint':                        'xy9',
  'Generations':                       'g1',
  'Fates Collide':                     'xy10',
  'Steam Siege':                       'xy11',
  'Evolutions':                        'xy12',

  // Sun & Moon era
  'Sun & Moon':                        'sm1',
  'Guardians Rising':                  'sm2',
  'Burning Shadows':                   'sm3',
  'Shining Legends':                   'sm35',
  'Crimson Invasion':                  'sm4',
  'Ultra Prism':                       'sm5',
  'Forbidden Light':                   'sm6',
  'Celestial Storm':                   'sm7',
  'Dragon Majesty':                    'sm75',
  'Lost Thunder':                      'sm8',
  'Team Up':                           'sm9',
  'Unbroken Bonds':                    'sm10',
  'Unified Minds':                     'sm11',
  'Hidden Fates':                      'sm115',
  'Cosmic Eclipse':                    'sm12',

  // Sword & Shield era
  'Sword & Shield':                    'swsh1',
  'Rebel Clash':                       'swsh2',
  'Darkness Ablaze':                   'swsh3',
  "Champion's Path":                   'swsh35',
  'Vivid Voltage':                     'swsh4',
  'Shining Fates':                     'swsh45',
  'Battle Styles':                     'swsh5',
  'Chilling Reign':                    'swsh6',
  'Evolving Skies':                    'swsh7',
  'Celebrations':                      'cel25',
  'Fusion Strike':                     'swsh8',
  'Brilliant Stars':                   'swsh9',
  'Astral Radiance':                   'swsh10',
  'Pokémon GO':                        'pgo',
  'Lost Origin':                       'swsh11',
  'Silver Tempest':                    'swsh12',
  'Crown Zenith':                      'swshp',

  // Scarlet & Violet era
  'Scarlet & Violet':                  'sv1',
  'Paldea Evolved':                    'sv2',
  'Obsidian Flames':                   'sv3',
  '151':                               'sv3pt5',
  'Paradox Rift':                      'sv4',
  'Paldean Fates':                     'sv4pt5',
  'Temporal Forces':                   'sv5',
  'Twilight Masquerade':               'sv6',
  'Shrouded Fable':                    'sv6pt5',
  'Stellar Crown':                     'sv7',
  'Surging Sparks':                    'sv8',
  'Prismatic Evolutions':              'sv8pt5',
  'Journey Together':                  'sv9',

  // Promo sets
  'Black Star Promos':                 'basep',
  'Nintendo Black Star Promos':        'np',
  'HeartGold & SoulSilver Promos':     'hsp',
  'Black & White Promos':              'bwp',
  'XY Promos':                         'xyp',
  'Sun & Moon Promos':                 'smp',
  'Sword & Shield Promos':             'swshp',
  'Scarlet & Violet Promos':           'svp',

  // McDonald's / special sets
  "McDonald's Collection 2011":        'mcd11',
  "McDonald's Collection 2012":        'mcd12',
  "McDonald's Collection 2014":        'mcd14',
  "McDonald's Collection 2015":        'mcd15',
  "McDonald's Collection 2016":        'mcd16',
  "McDonald's Collection 2017":        'mcd17',
  "McDonald's Collection 2018":        'mcd18',
  "McDonald's Collection 2019":        'mcd19',
  "McDonald's Collection 2021":        'mcd21',
  "McDonald's Collection 2022":        'mcd22',
  "McDonald's Match Battle":           'fut20',

  // POP / League series
  'POP Series 1':                      'pop1',
  'POP Series 2':                      'pop2',
  'POP Series 3':                      'pop3',
  'POP Series 4':                      'pop4',
  'POP Series 5':                      'pop5',
  'POP Series 6':                      'pop6',
  'POP Series 7':                      'pop7',
  'POP Series 8':                      'pop8',
  'POP Series 9':                      'pop9',

  // Detective Pikachu / SWSH specials
  'Detective Pikachu':                 'det1',
  'Sword & Shield - Trainer Gallery':  'tg',
}

/** Reverse map: Scrydex ID → TCGPlayer set name */
export const SCRYDEX_TO_SET_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(POKEMON_SET_MAP).map(([name, id]) => [id, name])
)

/**
 * Returns the Scrydex set ID for a given TCGPlayer set name, or null if unknown.
 * Matching is case-insensitive and accent-normalized (é → e).
 */
export function getScrydexSetId(setName: string): string | null {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/é/g, 'e')  // é
      .replace(/É/g, 'e')  // É
      .trim()

  const needle = normalise(setName)
  for (const [name, id] of Object.entries(POKEMON_SET_MAP)) {
    if (normalise(name) === needle) return id
  }
  return null
}
