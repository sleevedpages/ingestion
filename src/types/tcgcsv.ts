export interface TcgApiResponse<T> {
  results: T[];
  totalItems?: number;
}

export interface TcgCategory {
  categoryId: number;
  name: string;
  displayName: string;
  modifiedOn: string;
  image: string;
  seoText: string | null;
  isDirectBrand: boolean;
}

export interface TcgGroup {
  groupId: number;
  name: string;
  abbreviation: string | null;
  isSupplemental: boolean;
  publishedOn: string | null;
  modifiedOn: string;
  categoryId: number;
}

export interface TcgExtendedData {
  name: string;
  displayName: string;
  value: string;
}

export interface TcgProduct {
  productId: number;
  name: string;
  cleanName: string;
  imageUrl: string;
  categoryId: number;
  groupId: number;
  url: string;
  modifiedOn: string;
  imageCount: number;
  presaleInfo: {
    isPresale: boolean;
    releasedOn: string | null;
    note: string | null;
  } | null;
  extendedData: TcgExtendedData[];
}

export interface TcgPrice {
  productId: number;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
  directLowPrice: number | null;
  subTypeName: string;
}
