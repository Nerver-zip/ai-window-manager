export function isProviderVisible(providerId: string, fakeProviderEnabled: boolean): boolean {
  return providerId !== 'fake' || fakeProviderEnabled;
}

export function filterVisibleProviders<T extends { id: string }>(
  providers: readonly T[],
  fakeProviderEnabled: boolean,
): T[] {
  return providers.filter((provider) => isProviderVisible(provider.id, fakeProviderEnabled));
}
