import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import db from '../models/database';

const router = express.Router();
const DATA_DIR = path.resolve(process.cwd(), 'data');

/**
 * GET /api/projects
 * Get all projects
 */
router.get('/', async (req, res) => {
  try {
    const projects = await db.all(`
      SELECT id, name, created_at
      FROM projects
      ORDER BY created_at DESC
    `);
    
    res.json(projects);
  } catch (err) {
    console.error('Error getting projects:', err);
    res.status(500).json({ error: 'Failed to get projects' });
  }
});

/**
 * POST /api/projects
 * Create a new project
 */
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    
    // Sanitize project name for filesystem use
    const sanitizedName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    
    // Create project directory structure using project name instead of ID
    let projectDir = path.join(DATA_DIR, 'projects', sanitizedName);
    let notesDir = path.join(projectDir, 'notes');
    let citationsDir = path.join(projectDir, 'citations');
    
    // Check if a project directory with this name already exists
    try {
      await fs.access(projectDir);
      // If we get here, the directory exists
      console.log(`Directory ${projectDir} already exists, using incremental name`);
      
      // Add a numeric suffix to make the name unique
      let counter = 1;
      let uniqueName = `${sanitizedName}_${counter}`;
      let uniqueDir = path.join(DATA_DIR, 'projects', uniqueName);
      
      while (true) {
        try {
          await fs.access(uniqueDir);
          // Directory exists, try next number
          counter++;
          uniqueName = `${sanitizedName}_${counter}`;
          uniqueDir = path.join(DATA_DIR, 'projects', uniqueName);
        } catch (err) {
          // Directory doesn't exist, we can use this name
          break;
        }
      }
      
      // Update variables to use the unique name
      projectDir = uniqueDir;
      notesDir = path.join(projectDir, 'notes');
      citationsDir = path.join(projectDir, 'citations');
    } catch (err) {
      // Directory doesn't exist, which is what we want
    }
    
    // Create directories
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(notesDir, { recursive: true });
    await fs.mkdir(citationsDir, { recursive: true });
    
    console.log(`Project directories created at: ${projectDir}`);
    
    // Insert project in database
    const result = await db.run(`
      INSERT INTO projects (name, created_at)
      VALUES (?, datetime('now'))
    `, [name]);
    
    const projectId = result.lastID;
    
    // Store the directory path in the database for reference
    await db.run(`
      UPDATE projects
      SET directory_path = ?
      WHERE id = ?
    `, [projectDir, projectId]);
    
    // Fix: Pass projectId as an array to match the expected parameter type
    const newProject = await db.get('SELECT * FROM projects WHERE id = ?', [projectId]);
    
    res.status(201).json(newProject);
  } catch (err) {
    console.error('Error creating project:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

/**
 * DELETE /api/projects/:id
 * Delete a project and all associated data
 */
router.delete('/:id', async (req, res) => {
  try {
    const projectId = req.params.id;
    
    // First, get the project to check if it exists and get its directory path
    const project = await db.get('SELECT * FROM projects WHERE id = ?', [projectId]);
    
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    // Begin a transaction to ensure database integrity
    await db.run('BEGIN TRANSACTION');
    
    try {
      // Delete all tasks associated with this project
      await db.run('DELETE FROM tasks WHERE project_id = ?', [projectId]);
      
      // Delete all notes associated with this project
      await db.run('DELETE FROM notes WHERE project_id = ?', [projectId]);
      
      // Delete all citations associated with this project
      await db.run('DELETE FROM citations WHERE project_id = ?', [projectId]);
      
      // Finally delete the project itself
      await db.run('DELETE FROM projects WHERE id = ?', [projectId]);
      
      // Commit the transaction
      await db.run('COMMIT');
      
      // If the project has a directory path, try to delete it
      if (project.directory_path) {
        try {
          await fs.rm(project.directory_path, { recursive: true, force: true });
          console.log(`Project directory deleted: ${project.directory_path}`);
        } catch (fsErr) {
          console.error(`Warning: Could not delete project directory: ${project.directory_path}`, fsErr);
          // We don't fail the request if directory deletion fails
        }
      }
      
      res.json({ message: 'Project deleted successfully' });
    } catch (txErr) {
      // Roll back the transaction if anything fails
      await db.run('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('Error deleting project:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

export default router;