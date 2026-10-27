// Word lists authored for this project. Released under CC0 1.0.
// ponytail: lists are shorter than the spec's targets (~1,500 common words, ~300 swaps, ~200 antonyms);
// grow them while tuning against the golden set.

const set = (s: string) => new Set(s.trim().split(/\s+/));

export const STOPWORDS = set(`
a about above after again against all almost also although am an and another any anyone anything are around as at
be became because become been before being below between both but by can cannot could did do does doing done down during
each either else enough even ever every few for from further get gets got had has have having he her here hers herself him
himself his how however i if in into is it its itself just least less let like made make many may me might more most much
must my myself near neither no nor not now of off often on once one only or other others our ours ourselves out over own
per perhaps quite rather really same several shall she should since so some something sometimes such than that the their
theirs them themselves then there therefore these they this those though through thus to together too toward towards
under until up upon us very via was we well were what whatever when where whether which while who whom whose why will with
within without would yet you your yours yourself yourselves
`);

// Generic words that make poor study terms on their own.
export const COMMON = set(`
ability able account act action percent activity addition age amount answer approach area argument aspect attention back bit
body book case cause center century chance change chapter child children choice class company condition course day deal
degree detail development difference direction discussion effect effort end example experience fact factor family feature
field figure form friend front future game goal group half hand head help home hour idea importance information instance
interest issue item job kind lack level life line list lot man matter meaning means member method middle mind minute
moment month name nature need night number object order page paper part people period person picture piece place plan
point position power practice problem process program purpose question reason record relationship report rest result
right role room rule section sense series set side sign situation size someone something sort source space stage start
state step story student study subject system table task teacher term thing thought time today top topic total type unit
use value version view way week whole woman word work world year years yesterday
important different large small new old good great high long little main major many own same other certain various
specific general common possible real true whole special clear simple likely early late best better first last next
following such several overall usual typical
`);

export const PRONOUN_LEAD = set(`it this they these those that he she there its their his her such`);
export const FIRST_SECOND = set(`i me my mine we us our ours you your yours`);

export const ABBREVIATIONS = set(`
dr mr mrs ms prof sr jr st no vs etc e.g i.e u.s u.k a.m p.m approx dept fig vol ch pp ca mt ft gen gov sen rep
jan feb mar apr jun jul aug sep sept oct nov dec inc ltd co corp
`);

export const CAUSAL = /\b(because|therefore|as a result|leads? to|led to|causes?|caused|so that|results? in|due to)\b/i;
export const ENUMERATION = /\b(two|three|four|five|six|seven|eight|nine|ten|\d+) (?:main |major |basic |different |key )?(types|kinds|parts|stages|steps|ways|forms|categories|layers|branches|phases|groups|classes|causes|effects|properties|functions|reasons|features|elements)\b/i;
export const NEGATION = /\b(not|never|no|none|nothing|neither|nor|cannot)\b|n't\b/i;

export const ANTONYMS: [string, string][] = [
  ['increase', 'decrease'], ['increases', 'decreases'], ['increased', 'decreased'], ['before', 'after'],
  ['north', 'south'], ['east', 'west'], ['more', 'less'], ['higher', 'lower'], ['larger', 'smaller'],
  ['largest', 'smallest'], ['hot', 'cold'], ['warmer', 'cooler'], ['first', 'last'], ['inside', 'outside'],
  ['above', 'below'], ['early', 'late'], ['earlier', 'later'], ['strong', 'weak'], ['stronger', 'weaker'],
  ['fast', 'slow'], ['faster', 'slower'], ['rise', 'fall'], ['rises', 'falls'], ['rose', 'fell'], ['gain', 'lose'],
  ['gains', 'loses'], ['absorb', 'release'], ['absorbs', 'releases'], ['positive', 'negative'], ['upper', 'lower'],
  ['maximum', 'minimum'], ['expand', 'contract'], ['expands', 'contracts'], ['heavier', 'lighter'], ['dense', 'sparse'],
  ['import', 'export'], ['imports', 'exports'], ['accept', 'reject'], ['accepted', 'rejected'], ['win', 'lose'],
  ['won', 'lost'], ['victory', 'defeat'], ['ancient', 'modern'], ['wet', 'dry'], ['light', 'dark'], ['open', 'closed'],
  ['internal', 'external'], ['input', 'output'], ['top', 'bottom'], ['left', 'right'], ['young', 'old'],
  ['common', 'rare'], ['simple', 'complex'], ['natural', 'artificial'], ['always', 'rarely'], ['most', 'fewest'],
];

export const PLAIN_SWAPS: Record<string, string> = {
  utilize: 'use', utilizes: 'uses', utilized: 'used', utilization: 'use', approximately: 'about', commence: 'start',
  commences: 'starts', commenced: 'started', terminate: 'end', terminated: 'ended', sufficient: 'enough',
  insufficient: 'not enough', numerous: 'many', facilitate: 'help', facilitates: 'helps', demonstrate: 'show',
  demonstrates: 'shows', demonstrated: 'showed', obtain: 'get', obtains: 'gets', obtained: 'got', purchase: 'buy',
  purchased: 'bought', assist: 'help', assists: 'helps', assistance: 'help', additional: 'more', subsequently: 'later',
  prior: 'earlier', initiate: 'start', initiated: 'started', modify: 'change', modified: 'changed', require: 'need',
  requires: 'needs', required: 'needed', indicate: 'show', indicates: 'shows', indicated: 'showed', consequently: 'so',
  nevertheless: 'still', however: 'but', therefore: 'so', thus: 'so', individuals: 'people', individual: 'person',
  majority: 'most', component: 'part', components: 'parts', construct: 'build', constructed: 'built', inquire: 'ask',
  attempt: 'try', attempted: 'tried', attempts: 'tries', possess: 'have', possesses: 'has', possessed: 'had',
  regarding: 'about', concerning: 'about', fundamental: 'basic', principal: 'main', primary: 'main', reside: 'live',
  resides: 'lives', resided: 'lived', approximate: 'rough', frequently: 'often', commonly: 'often', identical: 'same',
  comprehend: 'understand', transmit: 'send', transmits: 'sends', transmitted: 'sent', locate: 'find', located: 'found',
  remainder: 'rest', inadequate: 'not enough', alteration: 'change', alterations: 'changes', beneficial: 'helpful',
  objective: 'goal', objectives: 'goals', anticipate: 'expect', anticipated: 'expected', ascertain: 'find out',
};
