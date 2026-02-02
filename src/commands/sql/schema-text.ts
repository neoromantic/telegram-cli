import type { TableAnnotation } from '../../db/schema-annotations'

function formatHeader(
  tableName: string,
  annotation: TableAnnotation,
): string[] {
  const lines: string[] = []
  lines.push(`Table: ${tableName}`)
  lines.push(`Description: ${annotation.description}`)
  if (annotation.ttl) {
    lines.push(`TTL: ${annotation.ttl}`)
  }
  const pk = Array.isArray(annotation.primaryKey)
    ? annotation.primaryKey.join(', ')
    : annotation.primaryKey
  lines.push(`Primary Key: ${pk}`)
  lines.push('')
  return lines
}

function formatColumnFlags(
  colName: string,
  annotation: TableAnnotation,
): string {
  const flags: string[] = []
  const pk = annotation.primaryKey
  const isPrimaryKey = Array.isArray(pk) ? pk.includes(colName) : pk === colName
  if (isPrimaryKey) {
    flags.push('PK')
  }
  if (annotation.columns[colName]?.nullable === false) {
    flags.push('NN')
  }
  const defaultValue = annotation.columns[colName]?.defaultValue
  if (defaultValue !== undefined) {
    flags.push(`=${defaultValue}`)
  }

  return flags.length > 0 ? `  [${flags.join(', ')}]` : ''
}

function formatColumnDetails(
  colName: string,
  annotation: TableAnnotation,
): string[] {
  const col = annotation.columns[colName]
  if (!col) return []

  const lines: string[] = []
  lines.push(`    ${col.description}`)
  if (col.enumValues) {
    lines.push(`    Values: ${col.enumValues.join(', ')}`)
  }
  if (col.semanticType) {
    lines.push(`    Type: ${col.semanticType}`)
  }
  return lines
}

function formatColumns(annotation: TableAnnotation): string[] {
  const lines: string[] = []
  lines.push('Columns:')

  for (const colName of Object.keys(annotation.columns)) {
    const flagStr = formatColumnFlags(colName, annotation)
    lines.push(`  ${colName}${flagStr}`)
    lines.push(...formatColumnDetails(colName, annotation))
  }

  return lines
}

function formatIndexes(annotation: TableAnnotation): string[] {
  if (!annotation.indexes || Object.keys(annotation.indexes).length === 0) {
    return []
  }

  const lines: string[] = []
  lines.push('')
  lines.push('Indexes:')
  for (const [indexName, desc] of Object.entries(annotation.indexes)) {
    lines.push(`  ${indexName}: ${desc}`)
  }
  return lines
}

export function formatSchemaAsText(
  tableName: string,
  annotation: TableAnnotation,
): string {
  const lines: string[] = []
  lines.push(...formatHeader(tableName, annotation))
  lines.push(...formatColumns(annotation))
  lines.push(...formatIndexes(annotation))
  return lines.join('\n')
}
