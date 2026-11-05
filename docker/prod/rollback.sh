# Refusals captured from SpacetimeDB CLI 2.8.1 (Dockerfile pin), 2026-10-31:
# column-removal manual migrations and nonempty-table removal. Other failures stop setup.
# The migration plan names each removed table before a refusal, so its line skips the word check.
# POSIX sh; sourced by module-setup.sh.
older_program() {
  [ -s "$1" ] || return 1
  awk -v esc="$(printf '\033')" '
    {
      gsub(esc "\\[[0-9;]*m", "")
      sub(/^[[:space:]]+/, "")
      sub(/[[:space:]]+$/, "")
      if ($0 == "") next
      if (state == 0 && $0 == "Errors occurred:") { state = 1; next }
      if (state == 1 && /^Removing a column [[:alnum:]_]+ from table [[:alnum:]_]+ requires a manual migration$/) { columns++; next }
      if (state == 1 && columns && $0 == "Aborting publish due to required manual migration.") { state = 2; next }
      if (state == 2 && $0 == "Error: Aborting because publishing would require manual migration or deletion of data and --delete-data was not specified.") { state = 3; next }
      if (state == 0 && /^Error: Failed to create or update the database: Cannot remove table `[[:alnum:]_]+`: table contains data\.( Clear the table\047s rows \(e\.g\. via a reducer\) before removing it from your schema\.)?$/) { state = 3; next }
      if (state == 0 && /^Removed table: [[:alnum:]_]+$/) next
      if (state != 0 || tolower($0) ~ /error|fatal|fail|panic|exception|abort|timed out|timeout|connection|could not connect|cannot connect|unable to connect/) { bad = 1; exit }
    }
    END { exit (bad || state != 3) }
  ' "$1"
}
