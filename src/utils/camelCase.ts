/**
 * Utility functions for converting objects from snake_case to camelCase
 * Used for API responses to frontend
 */

/**
 * Convert snake_case string to camelCase
 */
function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

/**
 * Check if a value is a plain object (not array, null, Date, etc.)
 */
function isPlainObject(value: any): boolean {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Recursively convert object keys from snake_case to camelCase
 */
export function toCamelCaseDeep(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(toCamelCaseDeep);
  }

  if (!isPlainObject(obj)) {
    return obj;
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = toCamelCase(key);
    result[camelKey] = toCamelCaseDeep(value);
  }

  return result;
}

/**
 * Express middleware to automatically convert response to camelCase
 */
export function camelCaseResponse() {
  return (req: any, res: any, next: any) => {
    const originalJson = res.json;

    res.json = function (body: any) {
      const camelCaseBody = toCamelCaseDeep(body);
      return originalJson.call(this, camelCaseBody);
    };

    next();
  };
}
