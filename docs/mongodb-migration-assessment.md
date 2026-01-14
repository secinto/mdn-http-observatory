# PostgreSQL to MongoDB Migration Assessment

## Summary

**Is it possible?** Yes, but with significant effort.

**Estimated effort:** 8-14 weeks of development work

---

## Current Database Architecture

### Database Layer
- **Driver:** Native `pg` package (no ORM)
- **Pattern:** Raw SQL with parameterized queries in `/src/database/repository.js`
- **Connection:** Pool-based with 40 max connections

### Schema (4 tables)
| Table | Purpose |
|-------|---------|
| `sites` | Domain registry (id, domain, creation_time) |
| `scans` | Scan results with grades/scores + JSONB headers |
| `tests` | Individual test results + JSONB output |
| `expectations` | Expected test outcomes per site |

### PostgreSQL-Specific Features in Use

| Feature | Usage | MongoDB Equivalent | Effort |
|---------|-------|-------------------|--------|
| **JSONB** (2 columns) | `scans.response_headers`, `tests.output` | Native documents | Low |
| **Materialized Views** (7) | Stats, grade distribution, score diffs | Aggregation pipelines + caching | **High** |
| **Window Functions** (`LAG`) | Score change history | `$setWindowFields` or app logic | Medium |
| **INTERVAL operations** | Time-based filtering | `$subtract` with dates | Low |
| **DISTINCT ON** | Latest scan per site | `$group` + `$first` | Medium |
| **Foreign Keys** | Referential integrity | Application-level or `$lookup` | Medium |
| **RETURNING clause** | Get inserted row | `returnDocument: 'after'` | Low |
| **Partial Indexes** | Filtered optimization | Partial indexes (supported) | Low |

---

## Why This Migration is Complex

### 1. Materialized Views (Biggest Challenge)
The app uses **7 materialized views** for statistics:
- `grade_distribution` - Grade counts
- `latest_scans` / `earliest_scans` - Per-site scan history
- `latest_tests` - Test results from latest scans
- `scan_score_difference_distribution` - Score improvements over time

These use complex SQL features (LATERAL joins, DISTINCT ON, window functions). MongoDB has no native MV equivalent - you'd need:
- Aggregation pipelines that run on-demand, OR
- A scheduled job that writes results to a collection, OR
- MongoDB Atlas Charts/Triggers for materialization

### 2. All Queries Are Raw SQL
Every database operation in `repository.js` (369 lines) is raw SQL:
```javascript
// Current PostgreSQL
await pool.query(`SELECT * FROM scans WHERE site_id = $1`, [siteId])

// Would become MongoDB
await db.collection('scans').findOne({ site_id: siteId })
```

All ~20 query functions must be manually rewritten.

### 3. Window Functions for History
The `selectScanHostHistory()` function uses `LAG()` to detect score changes:
```sql
LAG(score) OVER (ORDER BY end_time) AS prev_score
```
MongoDB added `$setWindowFields` in v5.0, but the syntax is quite different.

---

## Files Requiring Changes

| File | Lines | Changes |
|------|-------|---------|
| `src/database/repository.js` | 369 | Complete rewrite |
| `src/database/migrate.js` | 47 | New migration system |
| `src/config.js` | 145 | MongoDB connection config |
| `src/api/server.js` | 143 | Replace fastify-postgres |
| `migrations/*` | 10 files | Convert to JS migrations |
| `test/database.test.js` | 531 | Rewrite all tests |
| `package.json` | - | Replace `pg` with `mongodb` |
| `docker-compose.yml` | - | Replace postgres service |

---

## Effort Breakdown

| Component | Effort |
|-----------|--------|
| Core CRUD operations | 1-2 weeks |
| Replace materialized views with aggregations | 3-4 weeks |
| Window function logic | 1-2 weeks |
| Migration system & data migration | 1-2 weeks |
| Test suite rewrite | 1-2 weeks |
| Integration testing & bug fixes | 1-2 weeks |
| **Total** | **8-14 weeks** |

---

## Recommendation

### Don't Migrate If:
- PostgreSQL is working fine
- You just want a different database for preference
- The app is stable and not growing significantly

### Consider Migrating If:
- You need horizontal scaling beyond PostgreSQL's capabilities
- Your team has strong MongoDB expertise
- You're moving to a document-centric data model
- You need to embed test results directly in scan documents

### Alternative: Hybrid Approach
Keep PostgreSQL for structured data (sites, scans) and use MongoDB only for the JSONB fields (test outputs, headers) if document flexibility is the main driver.

---

## Conclusion

For **infrastructure consolidation**, the migration is feasible but represents significant work (8-14 weeks). The main blockers are:

1. **Materialized views** - Need a strategy for statistics/aggregations
2. **Raw SQL** - Complete rewrite of repository layer
3. **Testing** - Full test suite rewrite

If you decide to proceed in the future, the recommended approach would be:
1. Phase 1: Set up MongoDB, migrate schema, create indexes
2. Phase 2: Rewrite core CRUD operations
3. Phase 3: Replace materialized views with aggregation pipelines
4. Phase 4: Data migration and validation
5. Phase 5: Switch over and deprecate PostgreSQL
