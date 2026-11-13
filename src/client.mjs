export async function inspect(base) {
  const identity = await (await fetch(base + '/oai?verb=Identify')).json();
  const page = await (await fetch(base + '/oai?verb=ListRecords&from=' + identity.earliest + '&until=' + identity.today)).json();
  return { identity, firstPage: page };
}
