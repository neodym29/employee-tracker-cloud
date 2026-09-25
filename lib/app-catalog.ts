export const applicationCatalog = [
  {
    id: 'attorneys',
    name: 'Attorneys',
    description: 'Search the USPTO attorney directory.',
    url: 'https://attorneys.neodym.ai/',
    mark: 'A',
  },
  {
    id: 'examiners',
    name: 'Examiners',
    description: 'Explore USPTO examiner records.',
    url: 'https://examiners.neodym.ai/',
    mark: 'E',
  },
  {
    id: 'eternus',
    name: 'Eternus',
    description: 'Access the patent data API.',
    url: 'https://eternus.neodym.ai/',
    mark: 'ET',
  },
  {
    id: 'entropy',
    name: 'Patent Entropy',
    description: 'Open the drafting differentiation review.',
    url: 'https://entropy-review.vercel.app/',
    mark: 'PE',
  },
  {
    id: 'claim-structuring',
    name: 'Claim Structuring',
    description: 'Search patent records and review source-faithful claims.',
    url: 'https://patents.neodym.ai/',
    mark: 'CS',
  },
] as const;

export type ApplicationId = (typeof applicationCatalog)[number]['id'];
