import { useEffect, useState, type FormEvent } from "react";
import type { Project } from "@uw/contracts";
import { ApiError, api } from "../api/client";
import { ProjectWorkspace } from "./ProjectWorkspace";

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .listProjects()
      .then((items) => {
        if (active) setProjects(items);
      })
      .catch((cause) => {
        if (active) {
          setError(
            cause instanceof ApiError
              ? cause.message
              : "Unable to load projects",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const project = await api.createProject({ name });
      setProjects((current) => [...current, project]);
      setName("");
      setSelected(project);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Unable to create project",
      );
    }
  }

  if (selected) {
    return (
      <ProjectWorkspace project={selected} onBack={() => setSelected(null)} />
    );
  }

  return (
    <section aria-labelledby="projects-title">
      <h2 id="projects-title">Projects</h2>
      <form onSubmit={createProject}>
        <label>
          Project name
          <input
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button type="submit">Create Project</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {projects.length === 0 ? <p>No projects yet.</p> : null}
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          onClick={() => setSelected(project)}
        >
          {project.name}
        </button>
      ))}
    </section>
  );
}
