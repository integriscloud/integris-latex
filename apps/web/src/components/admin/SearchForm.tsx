import { Button, SelectField, TextField } from '@integris/ui';
import styles from './admin.module.css';

/** GET search form of a back-office list (the query string is the state: shareable, back-able). */
export function SearchForm({
  label,
  submit,
  q,
  filter,
}: {
  label: string;
  submit: string;
  q: string;
  filter?: {
    name: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
  };
}) {
  return (
    <form className={styles.search} method="get" role="search">
      <TextField label={label} name="q" type="search" defaultValue={q} maxLength={120} />
      {filter && (
        <SelectField
          label={filter.label}
          name={filter.name}
          defaultValue={filter.value}
          options={filter.options}
        />
      )}
      <Button type="submit" variant="secondary">
        {submit}
      </Button>
    </form>
  );
}

/** Link to the next page of a list (`before` = creation time of its last row). */
export function nextPageHref(path: string, query: Record<string, string>, cursor: string) {
  const params = new URLSearchParams({ ...query, before: cursor });
  for (const [key, value] of [...params]) if (!value) params.delete(key);
  return `${path}?${params}`;
}
