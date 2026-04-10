import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Module } from '../../modules/entities/module.entity';
import { UserEnrollment } from '../../enrollments/entities/user-enrollment.entity';
import { LessonTrack } from '../../tracking/entities/lesson-track.entity';

export enum CourseStatus {
  PUBLISHED = 'published',
  UNPUBLISHED = 'unpublished',
  ARCHIVED = 'archived',
}

export enum RewardType {
  CERTIFICATE = 'certificate',
  BADGE = 'badge',
}

@Entity('courses')
export class Course {
  @ApiProperty({ description: 'Unique identifier for the course', example: '123e4567-e89b-12d3-a456-426614174000' })
  @PrimaryGeneratedColumn('uuid')
  courseId: string;

  @ApiProperty({ description: 'Tenant ID for multi-tenancy support', example: '123e4567-e89b-12d3-a456-426614174000' })
  @Column({ type: 'uuid', nullable: true })
  @Index()
  tenantId: string;
  
  @ApiProperty({ description: 'Organization ID for organization-level data isolation', example: '123e4567-e89b-12d3-a456-426614174000' })
  @Column({ type: 'uuid', nullable: true })
  @Index()
  organisationId: string;

  @ApiProperty({ description: 'Course title', example: 'Introduction to Web Development' })
  @Column({ type: 'varchar', length: 255 })
  @Index()
  title: string;

  @ApiProperty({ description: 'Course alias or short name', example: 'intro-web-dev', required: true })
  @Column({ type: 'text'})
  @Index()
  alias: string;

  @ApiProperty({ description: 'Short description of the course', example: 'A brief intro to web development', required: false })
  @Column({ type: 'text', nullable: true })
  shortDescription: string;

  @ApiProperty({ description: 'Detailed description of the course', example: 'Learn the fundamentals of web development', required: false })
  @Column({ type: 'text'})
  description: string;

  @ApiProperty({ description: 'Course image path', example: 'https://example.com/images/course-thumb.jpg', required: false })
  @Column({ type: 'varchar', length: 255, nullable: true })
  image: string;

  @ApiProperty({ description: 'Whether the course is featured', example: false, default: false })
  @Column({ type: 'boolean', default: false })
  featured: boolean;

  @ApiProperty({ description: 'Whether the course is free', example: false, default: false })
  @Column({ type: 'boolean', default: false })
  free: boolean;

  @ApiProperty({ description: 'Certificate term', required: false })
  @Column({ type: 'jsonb', nullable: true })
  certificateTerm: Record<string, any>;

  @ApiProperty({ description: 'Type of reward for course completion', enum: RewardType, example: RewardType.CERTIFICATE, required: false })
  @Column({ type: 'varchar', length: 50, nullable: true })
  rewardType: RewardType;

  @ApiProperty({ description: 'Template ID for the reward', example: '123e4567-e89b-12d3-a456-426614174000', required: false })
  @Column({ type: 'uuid', nullable: true })
  templateId: string;

  @ApiProperty({ 
    description: 'Prerequisites for the course - array of prerequisite course IDs', 
    example: ['123e4567-e89b-12d3-a456-426614174000', '987fcdeb-51a2-43c1-b456-426614174000'],
    required: false,
    type: [String],
    isArray: true
  })
  @Column({ type: 'uuid', array: true, nullable: true })
  prerequisites: string[];

  @ApiProperty({ description: 'Course start date and time', example: '2023-01-01T00:00:00Z', required: false })
  @Column({ type: 'timestamptz', nullable: true })
  startDatetime: Date;

  @ApiProperty({ description: 'Course end date and time', example: '2023-12-31T23:59:59Z', required: false })
  @Column({ type: 'timestamptz', nullable: true })
  endDatetime: Date;

  @ApiProperty({ description: 'Whether admin approval is required', example: false, default: false })
  @Column({ type: 'boolean', default: false })
  adminApproval: boolean;

  @ApiProperty({ description: 'Whether auto-enrollment is enabled', example: false, default: false })
  @Column({ type: 'boolean', default: false })
  autoEnroll: boolean;

  @ApiProperty({ description: 'Course status', enum: CourseStatus, example: CourseStatus.PUBLISHED, default: CourseStatus.UNPUBLISHED })
  @Column({
    type: 'varchar',
    length: 255,
    enum: CourseStatus,
    default: CourseStatus.UNPUBLISHED,
  })
  status: CourseStatus;

  @ApiProperty({ description: 'Additional parameters', required: false })
  @Column({ type: 'jsonb', nullable: true })
  params: Record<string, any>;

  @ApiProperty({ 
    description: 'Course pricing information', 
    example: { amount: 99.99, currency: 'USD', type: 'one-time' },
    required: false
  })
  @Column({ type: 'jsonb', nullable: true })
  pricing: Record<string, any>;

  @ApiProperty({ 
    description: 'Certificate generation date and time', 
    example: '2025-01-01T12:00:00Z',
    required: false
  })
  @Column({ type: 'timestamptz', nullable: true })
  certificateGenDateTime: Date;

  @ApiProperty({
    description: 'Certificate issue date and time',
    example: '2025-01-01T12:00:00Z',
    required: false,
  })
  @Column({ type: 'timestamptz', nullable: true })
  certificateIssueDateTime: Date;

  @ApiProperty({ 
    description: 'Course order within organization/tenant', 
    example: 1,
    default: 0
  })
  @Column({ type: 'integer', default: 0 })
  ordering: number;

  @ApiProperty({ description: 'User who created the course', example: '123e4567-e89b-12d3-a456-426614174000' })
  @Column({ type: 'uuid' })
  createdBy: string;

  @ApiProperty({ description: 'Creation timestamp', example: '2023-01-01T00:00:00Z' })
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @ApiProperty({ description: 'User who last updated the course', example: '123e4567-e89b-12d3-a456-426614174000' })
  @Column({ type: 'uuid' })
  updatedBy: string;

  @ApiProperty({ description: 'Last update timestamp', example: '2023-01-01T00:00:00Z' })
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // Relationships
  @OneToMany(() => Module, module => module.course)
  modules: Module[];
  
  @OneToMany(() => UserEnrollment, enrollment => enrollment.course)
  enrollments: UserEnrollment[];

  @OneToMany(() => LessonTrack, (track) => track.course)
  lessonTracks: LessonTrack[];
}