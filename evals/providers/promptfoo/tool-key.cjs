function toolKey(name, args) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return `${name}:${JSON.stringify(canonical(args))}`;
}

module.exports = { toolKey };
