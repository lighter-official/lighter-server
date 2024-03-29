import { Injectable, OnModuleInit } from '@nestjs/common';
import { User, WritingSession, WritingSessionStatus } from '@prisma/client';
import {
  CreateWritingSessionDto,
  UpdateWritingSessionDto,
} from './writing-session.dto';
import { PrismaService } from 'src/db/prisma/prisma.service';
import { Exception, ExceptionCode } from 'src/app.exception';
import { day } from 'src/lib/dayjs';
import { WritingSessionStartAt } from './writing-session.type';
import * as cron from 'node-cron';
import { makeCronExpression } from 'src/context/utils/makeCronExpreesion';
@Injectable()
export class WritingSessionService implements OnModuleInit {
  constructor(private readonly prismaService: PrismaService) {}
  onModuleInit() {
    this.refreshCronTasks();
  }

  async createWritingSession(
    user: User,
    createWritingSessionDto: CreateWritingSessionDto,
  ) {
    const { page, period, startAt, subject, writingHours } =
      createWritingSessionDto;

    const existingOnProcessWritingSession =
      await this.prismaService.writingSession.findFirst({
        where: { userId: user.id, status: WritingSessionStatus.onProcess },
      });
    if (existingOnProcessWritingSession)
      throw new Exception(
        ExceptionCode.BadRequest,
        '진행 중인 글쓰기가 있습니다.',
      );

    if (
      !page ||
      !period ||
      !startAt ||
      (!startAt.hour && startAt.hour !== 0) ||
      (!startAt.minute && startAt.minute !== 0) ||
      !subject ||
      !writingHours
    ) {
      console.log('page:', page, 'period:', period, 'startAt:', startAt);
      throw new Exception(ExceptionCode.InsufficientParameters);
    }

    const _startDate = this.getStartDate(startAt);
    const startDate = _startDate.toDate();
    const nearestFinishDate = _startDate.add(writingHours, 'hour');
    const _finishDate = nearestFinishDate.add(period, 'day');
    const finishDate = _finishDate.toDate();

    const writingSession = await this.prismaService.writingSession.create({
      data: {
        page,
        period,
        startAt,
        subject,
        writingHours,
        userId: user.id,
        startDate,
        nearestStartDate: startDate,
        finishDate,
        nearestFinishDate: nearestFinishDate.toDate(),
      },
    });

    this.registerWritingSessionCronJobs(writingSession);

    return writingSession;
  }

  async getOnProcessWritingSession(user: User) {
    const writingSession = await this.prismaService.writingSession.findFirst({
      where: { userId: user.id, status: WritingSessionStatus.onProcess },
      include: {
        writings: {
          select: { id: true, title: true, content: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    return writingSession;
  }

  getStartDate(startAt: WritingSessionStartAt) {
    const { hour, minute } = startAt;
    let startDate = day()
      .set('hour', hour)
      .set('minute', minute)
      .set('second', 0);

    const now = day();
    if (now.isAfter(startDate)) {
      startDate = startDate.add(1, 'day');
    }

    return startDate;
  }

  private async activateWritingSession(id: number) {
    const nearestStartDate = day()
      .add(1, 'day')
      .set('second', 0)
      .set('millisecond', 0)
      .toDate();
    const writingSession = await this.prismaService.writingSession.update({
      where: { id },
      data: { isActivated: true, nearestStartDate },
    });

    return writingSession.isActivated;
  }

  async deactivateWritingSession(id: number) {
    const nearestFinishDate = day()
      .add(1, 'day')
      .set('second', 0)
      .set('millisecond', 0)
      .toDate();
    const writingSession = await this.prismaService.writingSession.update({
      where: { id },
      data: { isActivated: false, nearestFinishDate },
    });
    const now = day().add(1, 'minute');
    const { finishDate } = writingSession;

    // writingSession종료
    if (now.isAfter(finishDate)) {
      await this.updateWritingSessionStatusToCompleteFromOnProcess(id);
    }

    return writingSession.isActivated;
  }

  async updateWritingSessionStatusToCompleteFromOnProcess(id: number) {
    const writingSession = await this.prismaService.writingSession.findUnique({
      where: { id },
    });

    const updatedWritingSession =
      await this.prismaService.writingSession.update({
        where: { id },
        data: { status: WritingSessionStatus.completed },
      });
    await this.prismaService.cronTask.deleteMany({
      where: { name: { startsWith: `${writingSession.userId}/` } },
    });

    return updatedWritingSession;
  }

  async registerWritingSessionCronJobs(writingSession: WritingSession) {
    const activateCronName = `${writingSession.userId}/${writingSession.id}/activate`;
    const activateCronExpression = makeCronExpression(writingSession.startDate);
    const deactivateCronName = `${writingSession.userId}/${writingSession.id}/deactivate`;
    const deactivateCronExpression = makeCronExpression(
      writingSession.finishDate,
    );
    cron.schedule(
      activateCronExpression,
      () => {
        this.activateWritingSession(writingSession.id);
      },
      { name: activateCronName },
    );
    cron.schedule(
      deactivateCronExpression,
      () => {
        this.deactivateWritingSession(writingSession.id);
      },
      { name: deactivateCronName },
    );

    const cronJobs = await this.prismaService.cronTask.createMany({
      data: [
        {
          name: activateCronName,
          expression: activateCronExpression,
          type: 'activate',
        },
        {
          name: deactivateCronName,
          expression: deactivateCronExpression,
          type: 'deactivate',
        },
      ],
    });

    return cronJobs;
  }

  async getCronTasks() {
    const cronTasks = cron.getTasks();
    const keys = [];
    for (const [key, value] of cronTasks.entries()) {
      keys.push(key);
    }

    return keys;
  }

  /**
   * 앱 재시작시 cronTasks 등록
   */
  async refreshCronTasks() {
    const cronTasks = await this.prismaService.cronTask.findMany();
    console.log(`${cronTasks.length}개 cronJob 다시 등록`);

    cronTasks.forEach(({ name, type, expression }) => {
      const writingSessionId = Number(name.split('/')[1]);

      switch (type) {
        case 'activate':
          cron.schedule(
            expression,
            () => {
              this.activateWritingSession(writingSessionId);
            },
            { name },
          );
          break;

        case 'deactivate':
          cron.schedule(
            expression,
            () => {
              this.deactivateWritingSession(writingSessionId);
            },
            { name },
          );
          break;
      }
    });
  }
}
