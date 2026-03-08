alter table projects
  add column if not exists project_slug text;

update projects
set project_slug = case
  when project_slug is not null and project_slug != '' then project_slug
  else null
end;

update projects
set project_slug = case
  when project_slug is not null and project_slug != '' then project_slug
  else
    case
      when regexp_replace(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '(^-|-$)', '', 'g') = ''
        then 'app'
      else regexp_replace(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '(^-|-$)', '', 'g')
    end
end;

alter table projects
  alter column project_slug set not null;

create unique index if not exists projects_name_unique_ci on projects (lower(name));
create unique index if not exists projects_project_slug_unique on projects (project_slug);
